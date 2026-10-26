/**
 * Multi-instance manager: settings, lifecycle and the dashboard snapshot.
 *
 * One instance = one {@link InstanceRuntime}. Install/detect/update stay shared:
 * the manager prepares the published package or source checkout once, then each
 * runtime spawns its own DSH process with its own `DSH_HOME` and port.
 *
 * @module instance-manager
 */

import * as fs from 'node:fs'
import * as net from 'node:net'
import * as vscode from 'vscode'
import { MIN_INSTANCE_PORT_BASE } from './env.ts'
import {
  instanceHome,
  nextPort,
  sameHome,
  validateInstance,
  type DshInstance,
  type InstanceInput,
  type InstanceIssue,
  type NormalizedInstances,
} from './instances.ts'
import type { ActivityEntry } from './server/activity.ts'
import {
  addActivity,
  activityLogFile,
  dbg,
  fileSizeSafe,
  getActivity,
  withBusy,
} from './server/activity.ts'
import type { CheckoutHost } from './server/checkout.ts'
import { ensureCheckoutReady } from './server/checkout.ts'
import { readConfig } from './server/config.ts'
import { detectDsh, detectDshVersion, type DetectHost } from './server/detect.ts'
import { probeNodeVersion } from './server/node-check.ts'
import { runInTerminal as runInTerminalInner, type TerminalHost } from './server/terminal.ts'
import {
  ensurePnpmAvailable,
  ensureSourceCheckout,
  findSourceCheckout,
  pkgInstallDir,
  preparePkgStart,
  type InstallHost,
} from './server/install.ts'
import {
  InstanceRuntime,
  type InstanceRuntimeStatus,
  type PreparedDsh,
  type RuntimeHost,
} from './server/instance-runtime.ts'
import { settingsWriteFailure } from './instance-bootstrap.ts'
import {
  instanceModelOptions,
  markInstancesAuthoritative,
  readInitialInstances,
  readInstanceSettings,
  writeActiveInstance,
  writeInstances,
} from './server/instance-store.ts'
import { maskPath } from './paths.ts'
import { DETECTION_CACHE_TTL_MS, UPDATE_CHECK_TTL_MS } from './timing.ts'
import { versionFromDescribe } from './versions.ts'
import { checkDshUpdateStatus, isUpdating, runDshUpdate, type DshUpdate, type UpdateHost } from './server/update.ts'

/** The dashboard snapshot the webview consumes. */
export interface InstanceDashboard {
  status: {
    running: boolean
    starting: boolean
    installing: boolean
    stopping: boolean
    checking: boolean
    updating: boolean
    url: string
    dsh: 'unknown' | 'ok' | 'missing'
    dshVersion: string
    dshPath: string
    dshHome: string
    dshPathShort: string
    dshHomeShort: string
    nodeVersion: string
    mode: 'pnpm' | 'source'
    update: DshUpdate | undefined
    consoleLogPath: string
    consoleLogPathShort: string
    serverLogPath: string
    serverLogPathShort: string
    consoleLogSize: number
    serverLogSize: number
    sourceDebug: boolean
  }
  instances: InstanceRuntimeStatus[]
  active: InstanceRuntimeStatus | undefined
  activeId: string
  issues: InstanceIssue[]
}

/** Result of a create/edit submission. */
export interface InstanceMutation {
  instance?: DshInstance
  issues: InstanceIssue[]
}

/** The runtime host shared by every instance. */
class ManagerHost implements RuntimeHost {
  constructor(private readonly manager: InstanceManager) {}

  prepare(): Promise<PreparedDsh | undefined> {
    return this.manager.prepare()
  }

  isDshMissing(): boolean {
    return this.manager.isDshMissing()
  }

  isHomeRunning(home: string, exceptId: string): boolean {
    return this.manager.isHomeRunning(home, exceptId)
  }

  addActivity(line: string, isBusy?: boolean): number {
    return addActivity(line, isBusy)
  }

  dbg(line: string): void {
    dbg(line)
  }
}

/** The terminal layer's view of the manager. */
const terminalHost: TerminalHost = { addActivity }

let activeManager: InstanceManager | undefined

/** The extension creates one manager at activation; panel/actions read it. */
export function setInstanceManager(manager: InstanceManager): void {
  activeManager = manager
}

/** The manager created at activation. */
export function getInstanceManager(): InstanceManager | undefined {
  return activeManager
}

export class InstanceManager {
  private settings: NormalizedInstances = { instances: [], activeId: '', issues: [] }
  private readonly runtimes = new Map<string, InstanceRuntime>()
  private readonly host: ManagerHost
  private readyPromise: Promise<void> | undefined
  private readyError = ''
  private preparePromise: Promise<PreparedDsh | undefined> | undefined
  private dshVersion = ''
  private dshPath = ''
  private dshState: 'unknown' | 'ok' | 'missing' = 'unknown'
  private nodeVersion = ''
  private detectionAt = 0
  private logLineSeq = 0
  private updateCache: { update: DshUpdate; at: number } | undefined
  private updateCheckedAt = 0
  private checkPromise: Promise<DshUpdate | undefined> | undefined
  private checkingUpdate = false

  constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState'>) {
    this.host = new ManagerHost(this)
  }

  /**
   * Load settings, work out the first-run instance list and build runtimes.
   *
   * A failed attempt must stay retryable: caching the rejection would keep every
   * later `dashboard()` throwing and leave the panel permanently empty, with no
   * way back except reloading the window. `readyError` carries the failure to
   * the panel, which renders it next to whatever instances are known.
   */
  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    const attempt = this.initialize()
    this.readyPromise = attempt
    attempt.catch((error) => {
      this.readyError = error instanceof Error ? error.message : String(error)
      if (this.readyPromise === attempt) this.readyPromise = undefined
    })
    return attempt
  }

  private async initialize(): Promise<void> {
    this.readyError = ''
    this.settings = await readInitialInstances(this.context)
    this.rebuildRuntimes()
    this.nodeVersion = await probeNodeVersion(readConfig().nodePath).catch(() => '')
    for (const issue of this.settings.issues) addActivity(`⚠ ${issue.message}`)
  }

  private rebuildRuntimes(): void {
    this.runtimes.clear()
    for (const instance of this.settings.instances) {
      this.runtimes.set(instance.id, new InstanceRuntime(instance, this.host))
    }
  }

  private get activeId(): string {
    if (this.settings.activeId && this.runtimes.has(this.settings.activeId)) return this.settings.activeId
    return this.settings.instances[0]?.id ?? ''
  }

  private get activeRuntime(): InstanceRuntime | undefined {
    return this.runtimes.get(this.activeId)
  }

  instances(): DshInstance[] {
    return this.settings.instances
  }

  issues(): InstanceIssue[] {
    const issues = [...this.settings.issues]
    if (this.readyError !== '') {
      issues.push({ index: -1, field: 'entry', severity: 'error', message: `launcher initialization failed: ${this.readyError}` })
    }
    return issues
  }

  /** The active instance id the panel should mark; '' when none. */
  activeInstanceId(): string {
    return this.activeId
  }

  /**
   * Every known instance as a renderable status.
   *
   * Synchronous on purpose: it is also the fallback the panel renders when a
   * status refresh throws, so a failing subsystem never blanks the list.
   */
  instanceStatuses(): InstanceRuntimeStatus[] {
    return [...this.runtimes.values()].map((runtime) => runtime.status())
  }

  activeInstance(): DshInstance | undefined {
    const id = this.activeId
    return this.settings.instances.find((instance) => instance.id === id)
  }

  /** One instance by id. */
  instance(id: string): DshInstance | undefined {
    return this.settings.instances.find((instance) => instance.id === id)
  }

  /** One runtime status by id. */
  statusOf(id: string): InstanceRuntimeStatus | undefined {
    return this.runtimes.get(id)?.status()
  }

  /** The URL to open for one instance, carrying its launch token when known. */
  uiUrl(id: string): string | undefined {
    return this.runtimes.get(id)?.status().uiUrl
  }

  /** Select an instance and persist the choice. */
  async select(id: string): Promise<void> {
    await this.ready()
    if (!this.runtimes.has(id)) return
    this.settings.activeId = id
    const saveError = await writeResult(writeActiveInstance(id))
    if (saveError !== undefined) addActivity(`⚠ could not remember the active instance: ${saveError}`)
  }

  /** Refresh every runtime from its port and re-detect the shared install. */
  async refresh(): Promise<void> {
    for (const runtime of this.runtimes.values()) await runtime.refresh()
    const now = Date.now()
    if (now - this.detectionAt > DETECTION_CACHE_TTL_MS) {
      this.detectionAt = now
      const cfg = readConfig()
      try {
        const detection = await detectDsh(cfg, this.detectHost())
        this.dshState = detection.state
        this.dshPath = detection.path
        await detectDshVersion(cfg, this.detectHost())
      } catch {
        this.dshState = 'unknown'
      }
    }
    // Keep the Update button honest without blocking a status refresh on the
    // registry/tag lookup: a stale cache starts one background check.
    const lastUpdateCheck = this.updateCache?.at ?? this.updateCheckedAt
    if (!this.checkingUpdate && Date.now() - lastUpdateCheck > UPDATE_CHECK_TTL_MS) {
      void this.checkUpdate()
    }
  }

  /** Drop the shared detection cache (after a mode/update change). */
  invalidateDetection(): void {
    this.detectionAt = 0
  }

  /** Check for a newer shared dsh; coalesced and cached for a few minutes. */
  checkUpdate(force = false): Promise<DshUpdate | undefined> {
    if (this.checkPromise) return this.checkPromise
    if (!force && this.updateCache && Date.now() - this.updateCache.at < UPDATE_CHECK_TTL_MS) {
      return Promise.resolve(this.updateCache.update)
    }
    this.checkingUpdate = true
    this.checkPromise = checkDshUpdateStatus(this.updateHost())
      .then((update) => {
        this.updateCache = { update, at: Date.now() }
        return update
      })
      .catch((error) => {
        addActivity(`⚠ Update check failed: ${error instanceof Error ? error.message : String(error)}`)
        return this.updateCache?.update
      })
      .finally(() => {
        this.checkingUpdate = false
        this.updateCheckedAt = Date.now()
        this.checkPromise = undefined
      })
    return this.checkPromise
  }

  private updateHost(): UpdateHost {
    return {
      readConfig: () => readConfig(),
      findSourceCheckout: () => findSourceCheckout(readConfig()),
      addActivity,
      withBusy,
      runInTerminal: (title, command, args, env) => runInTerminalInner(title, command, args, terminalHost, env),
      dbg,
      isStopped: () => !this.anyActive(),
      invalidateUpdateCache: () => { this.updateCache = undefined },
      installHost: this.installHost(),
      checkoutHost: this.checkoutHost(),
    }
  }

  /**
   * Recently active instance server output plus the shared launcher feed.
   *
   * Only the startup output is mirrored (see `InstanceRuntime.consoleLines`):
   * a running dsh's periodic plugin logging is not a launcher event and does
   * not belong in the panel console.
   */
  activityFor(id: string): ActivityEntry[] {
    const result: ActivityEntry[] = getActivity().map((entry) => ({ ...entry }))
    const runtime = this.runtimes.get(id)
    if (runtime) {
      const lines = runtime.consoleLines()
      if (lines.length > 0) {
        result.push({ id: --this.logLineSeq, text: `── ${runtime.instance.name} startup output ──`, busy: false })
        for (const line of lines) result.push({ id: --this.logLineSeq, text: line, busy: false })
      }
    }
    return result
  }

  /** Build the dashboard snapshot for the panel. */
  async dashboard(): Promise<InstanceDashboard> {
    // A failed bootstrap is reported through issues() below; the snapshot still
    // shows whatever instances are known, because an empty dashboard would hide
    // both the instances and the error.
    try {
      await this.ready()
    } catch {
      // readyError is rendered by the panel.
    }
    await this.refresh()
    const cfg = readConfig()
    const active = this.activeRuntime
    const status = active?.status()
    return {
      status: {
        running: status?.running ?? false,
        starting: status?.starting ?? false,
        installing: status?.installing ?? false,
        stopping: status?.stopping ?? false,
        checking: this.checkingUpdate,
        updating: isUpdating(),
        url: status?.url ?? '',
        dsh: this.dshState,
        dshVersion: this.dshVersion,
        dshPath: this.dshPath,
        dshHome: status?.home ?? '',
        dshPathShort: maskPath(this.dshPath),
        dshHomeShort: maskPath(status?.home ?? ''),
        nodeVersion: this.nodeVersion,
        mode: cfg.runMode,
        update: this.updateCache?.update,
        consoleLogPath: activityLogFile(),
        consoleLogPathShort: maskPath(activityLogFile()),
        serverLogPath: status?.logPath ?? '',
        serverLogPathShort: status?.logPathShort ?? '',
        consoleLogSize: fileSizeSafe(activityLogFile()),
        serverLogSize: status ? fileSizeSafe(status.logPath) : 0,
        sourceDebug: cfg.sourceDebug,
      },
      instances: this.instanceStatuses(),
      active: status,
      activeId: this.activeId,
      issues: this.issues(),
    }
  }

  /** Suggest a free port not used by another instance (five-digit base + 1). */
  async suggestPort(): Promise<number | undefined> {
    await this.ready()
    const used = new Set(this.settings.instances.map((instance) => instance.port))
    const base = readConfig().instancePortBase
    let candidate = nextPort(used, base + 1)
    // A base at the very top of the range has no room for +1; wrap to the
    // five-digit floor instead of reporting "no port".
    if (candidate === undefined) candidate = nextPort(used, MIN_INSTANCE_PORT_BASE)
    while (candidate !== undefined) {
      if (await isPortFree(candidate)) return candidate
      used.add(candidate)
      candidate = nextPort(used, candidate + 1)
    }
    return undefined
  }

  /** The form-facing error for a settings write that rejected. */
  private saveIssue(detail: string): InstanceIssue {
    return {
      index: 0,
      field: 'entry',
      severity: 'error',
      message: `could not save the instance list to VS Code settings: ${detail} — `
        + 'reload the window if the extension was just installed or updated, then try again',
    }
  }

  /**
   * Create a new instance; profile initialization is deferred to Start.
   *
   * The list is persisted *before* it is committed to memory and a runtime is
   * created. A failed save must not leave a phantom instance behind: that made a
   * retry report `name "…" is already used by another instance` for an instance
   * the panel never showed.
   */
  async create(input: InstanceInput): Promise<InstanceMutation> {
    await this.ready()
    const result = validateInstance(input, instanceModelOptions(), this.settings.instances)
    if (!result.instance) return { issues: result.issues }
    const instance = result.instance
    const home = instanceHome(instance, instanceModelOptions())
    try {
      if (fs.existsSync(home) && !fs.statSync(home).isDirectory()) {
        return { issues: [...result.issues, { index: 0, field: 'home', severity: 'error', message: 'home is a file' }] }
      }
      fs.mkdirSync(home, { recursive: true })
    } catch (error) {
      return { issues: [...result.issues, { index: 0, field: 'home', severity: 'error', message: `cannot create home: ${error instanceof Error ? error.message : String(error)}` }] }
    }
    const next = [...this.settings.instances, instance]
    const saveError = await writeResult(writeInstances(next))
    if (saveError !== undefined) return { issues: [...result.issues, this.saveIssue(saveError)] }
    this.settings.instances = next
    this.settings.activeId = instance.id
    this.runtimes.set(instance.id, new InstanceRuntime(instance, this.host))
    const activeError = await writeResult(writeActiveInstance(instance.id))
    if (activeError !== undefined) addActivity(`⚠ could not remember the active instance: ${activeError}`)
    return { instance, issues: result.issues }
  }

  /** Edit an instance; home/profile/port changes require a stopped runtime. */
  async update(id: string, input: InstanceInput): Promise<InstanceMutation> {
    await this.ready()
    const current = this.settings.instances.find((instance) => instance.id === id)
    if (!current) return { issues: [{ index: 0, field: 'entry', severity: 'error', message: 'instance not found' }] }
    const runtime = this.runtimes.get(id)
    if (runtime) {
      const status = runtime.status()
      if (status.running || status.starting || status.stopping || status.installing) {
        return { issues: [{ index: 0, field: 'entry', severity: 'error', message: 'stop the instance before editing it' }] }
      }
    }
    const result = validateInstance(input, instanceModelOptions(), this.settings.instances, id)
    if (!result.instance) return { issues: result.issues }
    const index = this.settings.instances.findIndex((instance) => instance.id === id)
    const next = [...this.settings.instances]
    next[index] = result.instance
    const saveError = await writeResult(writeInstances(next))
    if (saveError !== undefined) return { issues: [...result.issues, this.saveIssue(saveError)] }
    this.settings.instances = next
    runtime?.update(result.instance)
    return { instance: result.instance, issues: result.issues }
  }

  /** Remove an instance from the list; its DSH home is never deleted. */
  async remove(id: string): Promise<boolean> {
    await this.ready()
    const runtime = this.runtimes.get(id)
    if (runtime) {
      const status = runtime.status()
      if (status.running || status.starting || status.stopping || status.installing) return false
    }
    if (!this.settings.instances.some((instance) => instance.id === id)) return false
    const next = this.settings.instances.filter((instance) => instance.id !== id)
    const nextActiveId = this.settings.activeId === id ? (next[0]?.id ?? '') : this.settings.activeId
    const saveError = await writeResult(writeInstances(next))
    if (saveError !== undefined) {
      addActivity(`✗ could not remove the instance: ${saveError}`)
      return false
    }
    const activeError = await writeResult(writeActiveInstance(nextActiveId))
    if (activeError !== undefined) addActivity(`⚠ could not remember the active instance: ${activeError}`)
    runtime?.dispose()
    this.runtimes.delete(id)
    this.settings.instances = next
    this.settings.activeId = nextActiveId
    // An empty list is a decision, not a first run: remember it so the
    // synthesized Default is not resurrected on the next activation.
    if (next.length === 0) await markInstancesAuthoritative(this.context)
    return true
  }

  /** Start one instance and make it active. */
  async start(id: string): Promise<boolean> {
    await this.ready()
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    await this.select(id)
    return runtime.start()
  }

  /** Stop one instance. */
  async stop(id: string): Promise<boolean> {
    await this.ready()
    return (await this.runtimes.get(id)?.stop()) ?? false
  }

  /** Whether any instance is running/starting/stopping. */
  anyActive(): boolean {
    return [...this.runtimes.values()].some((runtime) => {
      const status = runtime.status()
      return status.running || status.starting || status.installing || status.stopping
    })
  }

  /** Another instance with the same normalized home is running. */
  isHomeRunning(home: string, exceptId: string): boolean {
    for (const [id, runtime] of this.runtimes) {
      if (id === exceptId) continue
      const status = runtime.status()
      if (!status.running && !status.starting) continue
      if (sameHome(status.home, home)) return true
    }
    return false
  }

  /** Whether the shared dsh is currently known to be missing. */
  isDshMissing(): boolean {
    return this.dshState === 'missing'
  }

  /** Shared install preparation; concurrent starts coalesce onto one install. */
  prepare(): Promise<PreparedDsh | undefined> {
    if (this.preparePromise) return this.preparePromise
    this.preparePromise = this.prepareInternal().finally(() => {
      this.preparePromise = undefined
    })
    return this.preparePromise
  }

  private async prepareInternal(): Promise<PreparedDsh | undefined> {
    const cfg = readConfig()
    await this.ready()
    const installHost = this.installHost()
    await detectDshVersion(cfg, this.detectHost())
    if (cfg.runMode === 'source') {
      const checkout = await ensureSourceCheckout(cfg, installHost)
      if (!checkout) return undefined
      if (!(await ensureCheckoutReady(checkout.path, this.checkoutHost(), checkout.cloned))) {
        this.dshState = 'missing'
        return undefined
      }
      this.dshPath = checkout.path
      await detectDshVersion(cfg, this.detectHost())
      const version = versionFromDescribe(this.dshVersion) ?? this.dshVersion
      this.dshVersion = version
      this.dshState = 'ok'
      return { mode: 'source', version, checkout: checkout.path }
    }

    const pnpm = await ensurePnpmAvailable(installHost)
    if (!pnpm) return undefined
    const version = await preparePkgStart(cfg, pnpm.command, pnpm.allowBuild, installHost)
    if (!version) return undefined
    this.dshVersion = version
    this.dshPath = pkgInstallDir(cfg)
    this.dshState = 'ok'
    return { mode: 'pnpm', version, pnpmCmd: pnpm.command, installDir: this.dshPath }
  }

  private detectHost(): DetectHost {
    return {
      findSourceCheckout: (cfg) => findSourceCheckout(cfg),
      setDshVersion: (version) => { this.dshVersion = version },
    }
  }

  private installHost(): InstallHost {
    return {
      addActivity,
      withBusy,
      runInTerminal: (title, command, args, env) => runInTerminalInner(title, command, args, terminalHost, env),
      runInstalling: (task) => task(),
      setDshVersion: (version) => { this.dshVersion = version },
      setDshState: (state) => { this.dshState = state },
      isStarting: () => this.anyActive(),
      dbg,
    }
  }

  private checkoutHost(): CheckoutHost {
    return {
      addActivity,
      runInTerminal: (title, command, args, env) => runInTerminalInner(title, command, args, terminalHost, env),
      runInstalling: (task) => task(),
      isStarting: () => this.anyActive(),
    }
  }

  /** Update the shared dsh install; requires every instance stopped. */
  async updateDsh(): Promise<void> {
    if (this.anyActive()) throw new Error('Stop all instances before updating dsh')
    await runDshUpdate(this.updateHost())
    this.updateCache = undefined
    this.invalidateDetection()
    await this.refresh()
    await this.checkUpdate(true)
  }

  /** Stop log pumps; running DSH processes are intentionally left alone. */
  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose()
  }

  /** Clear the selected instance's console/log plus the shared activity feed. */
  clearConsole(id: string): void {
    this.runtimes.get(id)?.clearLog()
  }

  /** Read settings again after an external settings edit. */
  async reloadSettings(): Promise<void> {
    this.settings = readInstanceSettings()
    this.rebuildRuntimes()
  }

  /** Normalized options for tests/panel forms. */
  modelOptions() {
    return instanceModelOptions()
  }

  /** Resolve an instance's home for the panel/edit form. */
  homeOf(instance: DshInstance): string {
    return instanceHome(instance, instanceModelOptions())
  }
}

/** Resolve one settings write to `undefined` (saved) or its failure reason. */
async function writeResult(write: PromiseLike<void>): Promise<string | undefined> {
  try {
    await write
    return undefined
  } catch (error) {
    return settingsWriteFailure(error)
  }
}

/** Whether a TCP port is free on loopback. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}
