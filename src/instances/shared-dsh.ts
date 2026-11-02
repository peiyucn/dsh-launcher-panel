import { addActivity, dbg, withBusy } from '../shared/activity.ts'
import type { CheckoutHost } from '../dsh/checkout.ts'
import { ensureCheckoutReady } from '../dsh/checkout.ts'
import { readConfig } from '../dsh/config.ts'
import { detectDsh, detectDshVersion, type DetectHost } from '../dsh/detect.ts'
import { probeNodeVersion } from '../dsh/node-check.ts'
import { runInTerminal as runInTerminalInner, type TerminalHost } from '../dsh/terminal.ts'
import {
  ensurePnpmAvailable,
  ensureSourceCheckout,
  findSourceCheckout,
  pkgInstallDir,
  preparePkgStart,
  unreachablePkgPath as unreachablePkgPathSetting,
  type InstallHost,
} from '../dsh/install.ts'
import { installedDshVersion, maskPath } from '../dsh/paths.ts'
import { reinstallInPlace } from '../dsh/reinstall.ts'
import { DETECTION_CACHE_TTL_MS, UPDATE_CHECK_TTL_MS } from '../shared/timing.ts'
import { versionFromDescribe } from '../dsh/versions.ts'
import { checkDshUpdateStatus, runDshUpdate, type DshUpdate, type UpdateHost } from '../dsh/update.ts'
import type { PreparedDsh } from './runtime/types.ts'

const terminalHost: TerminalHost = { addActivity }

/** Host members shared by the install/checkout/update builders. */
const flowHost = {
  addActivity,
  withBusy,
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) =>
    runInTerminalInner(title, command, args, terminalHost, env),
}

/** The one shared dsh install: detection, node/version state and update checks. */
export class SharedDsh {
  private readonly stopped: () => boolean
  private preparePromise: Promise<PreparedDsh | undefined> | undefined
  private dshVersionValue = ''
  private dshPathValue = ''
  private dshStateValue: 'unknown' | 'ok' | 'missing' = 'unknown'
  private nodeVersionValue = ''
  private detectionAt = 0
  private updateCache: { update: DshUpdate; at: number } | undefined
  private updateCheckedAt = 0
  private checkPromise: Promise<DshUpdate | undefined> | undefined
  private checkingUpdateValue = false

  constructor(stopped: () => boolean) {
    this.stopped = stopped
  }

  get dshVersion(): string {
    return this.dshVersionValue
  }

  get dshPath(): string {
    return this.dshPathValue
  }

  get dshState(): 'unknown' | 'ok' | 'missing' {
    return this.dshStateValue
  }

  get nodeVersion(): string {
    return this.nodeVersionValue
  }

  get checkingUpdate(): boolean {
    return this.checkingUpdateValue
  }

  get update(): DshUpdate | undefined {
    return this.updateCache?.update
  }

  async loadNodeVersion(): Promise<void> {
    this.nodeVersionValue = await probeNodeVersion(readConfig().nodePath).catch(() => '')
  }

  isDshMissing(): boolean {
    return this.dshStateValue === 'missing'
  }

  async refreshDetection(): Promise<void> {
    const now = Date.now()
    if (now - this.detectionAt > DETECTION_CACHE_TTL_MS) {
      this.detectionAt = now
      const cfg = readConfig()
      try {
        const detection = await detectDsh(cfg, this.detectHost())
        this.dshStateValue = detection.state
        this.dshPathValue = detection.path
        await detectDshVersion(cfg, this.detectHost())
      } catch {
        this.dshStateValue = 'unknown'
      }
    }
    const lastUpdateCheck = this.updateCache?.at ?? this.updateCheckedAt
    if (!this.checkingUpdateValue && Date.now() - lastUpdateCheck > UPDATE_CHECK_TTL_MS) void this.checkUpdate()
  }

  invalidateDetection(): void {
    this.detectionAt = 0
  }

  checkUpdate(force = false): Promise<DshUpdate | undefined> {
    if (this.checkPromise) return this.checkPromise
    if (!force && this.updateCache && Date.now() - this.updateCache.at < UPDATE_CHECK_TTL_MS) {
      return Promise.resolve(this.updateCache.update)
    }
    this.checkingUpdateValue = true
    this.checkPromise = checkDshUpdateStatus(this.updateHost())
      .then((update) => {
        this.updateCache = { update, at: Date.now() }
        return update
      })
      .catch((error) => {
        addActivity(`⚠ Update check failed: ${errorMessage(error)}`)
        return this.updateCache?.update
      })
      .finally(() => {
        this.checkingUpdateValue = false
        this.updateCheckedAt = Date.now()
        this.checkPromise = undefined
      })
    return this.checkPromise
  }

  prepare(convertAllowed = false): Promise<PreparedDsh | undefined> {
    if (this.preparePromise) return this.preparePromise
    this.preparePromise = this.prepareInternal(convertAllowed).finally(() => {
      this.preparePromise = undefined
    })
    return this.preparePromise
  }

  private async prepareInternal(convertAllowed: boolean): Promise<PreparedDsh | undefined> {
    const cfg = readConfig()
    // Read the source version after readiness: setup may build or change the checkout,
    // and a warm start needs no throwaway `git describe` before that guard.
    if (cfg.runMode === 'source') {
      const checkout = await ensureSourceCheckout(cfg, this.installHost())
      if (!checkout) return undefined
      if (!(await ensureCheckoutReady(checkout.path, this.checkoutHost(), checkout.cloned))) {
        this.dshStateValue = 'missing'
        return undefined
      }
      this.dshPathValue = checkout.path
      await detectDshVersion(cfg, this.detectHost())
      const version = versionFromDescribe(this.dshVersionValue) ?? this.dshVersionValue
      this.dshVersionValue = version
      this.dshStateValue = 'ok'
      return { mode: 'source', version, checkout: checkout.path }
    }
    // A pkgPath synced from another machine may not exist here; say so instead of
    // silently installing into the managed location.
    const installHost = this.installHost()
    await detectDshVersion(cfg, this.detectHost())
    const unreachable = unreachablePkgPathSetting(cfg)
    if (unreachable !== undefined) {
      addActivity(`⚠ dsh.pkgPath ${maskPath(unreachable)} is not reachable on this machine — using the managed install location (clear the setting to drop this warning)`)
    }
    const version = await preparePkgStart(cfg, installHost, convertAllowed)
    if (!version) return undefined
    this.dshVersionValue = version
    this.dshPathValue = pkgInstallDir(cfg)
    this.dshStateValue = 'ok'
    return { mode: 'pnpm', version, installDir: this.dshPathValue }
  }

  /** Requires every instance stopped; the caller checks that before calling. */
  async runUpdate(): Promise<void> {
    await runDshUpdate(this.updateHost())
    this.updateCache = undefined
  }

  /**
   * Rebuild the same dsh version with the configured package import method.
   * The rebuild happens in a staging folder and is switched in only on success.
   * Caller must ensure every instance is stopped.
   */
  async reinstallPkg(): Promise<boolean> {
    const cfg = readConfig()
    if (cfg.runMode !== 'pnpm') {
      addActivity('⚠ Reinstall applies to pkg mode only')
      return false
    }
    const dir = pkgInstallDir(cfg)
    const version = installedDshVersion(dir)
    if (version === undefined) {
      addActivity('⚠ dsh is not installed yet — Start installs it first')
      return false
    }
    const pnpm = await ensurePnpmAvailable(this.installHost())
    if (!pnpm) return false
    const ok = await reinstallInPlace(version, dir, pnpm.command, pnpm.allowBuild, cfg.packageImportMethod, this.installHost())
    if (ok) {
      this.dshVersionValue = version
      this.dshPathValue = dir
      this.dshStateValue = 'ok'
      this.invalidateDetection()
    }
    return ok
  }

  private detectHost(): DetectHost {
    return {
      findSourceCheckout: (cfg) => findSourceCheckout(cfg),
      setDshVersion: (version) => { this.dshVersionValue = version },
    }
  }

  private installHost(): InstallHost {
    return {
      ...flowHost,
      runInstalling: (task) => task(),
      setDshVersion: (version) => { this.dshVersionValue = version },
      setDshState: (state) => { this.dshStateValue = state },
      dbg,
    }
  }

  private checkoutHost(): CheckoutHost {
    return { ...flowHost, runInstalling: (task) => task() }
  }

  private updateHost(): UpdateHost {
    return {
      ...flowHost,
      readConfig: () => readConfig(),
      findSourceCheckout: () => findSourceCheckout(readConfig()),
      dbg,
      isStopped: () => this.stopped(),
      invalidateUpdateCache: () => { this.updateCache = undefined },
      installHost: this.installHost(),
      checkoutHost: this.checkoutHost(),
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
