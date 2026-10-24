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
import {
  instanceModelOptions,
  migrateLegacyInstances,
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
  private preparePromise: Promise<PreparedDsh | undefined> | undefined
  private dshVersion = ''
  private dshPath = ''
  private dshState: 'unknown' | 'ok' | 'missing' = 'unknown'
  private detectionAt = 0
  private logLineSeq = 0
  private updateCache: { update: DshUpdate; at: number } | undefined
  private updateCheckedAt = 0
  private checkPromise: Promise<DshUpdate | undefined> | undefined
  private checkingUpdate = false

  constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState'>) {
    this.host = new ManagerHost(this)
  }

  /** Load settings, run the one-time legacy migration and build runtimes. */
  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = (async () => {
      this.settings = await migrateLegacyInstances(this.context)
      this.rebuildRuntimes()
      if (this.settings.issues.length > 0) {
        for (const issue of this.settings.issues) addActivity(`⚠ Instance settings: ${issue.message}`)
      }
    })()
    return this.readyPromise
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
    return this.settings.issues
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
    if (!this.runtimes.has(id)) return
    this.settings.activeId = id
    await writeActiveInstance(id)
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

  /** Recently active instance server output plus the shared launcher feed. */
  activityFor(id: string): ActivityEntry[] {
    const result: ActivityEntry[] = getActivity().map((entry) => ({ ...entry }))
    const runtime = this.runtimes.get(id)
    if (runtime) {
      const lines = runtime.logLines()
      if (lines.length > 0) {
        result.push({ id: --this.logLineSeq, text: `── ${runtime.instance.name} server log ──`, busy: false })
        for (const line of lines) result.push({ id: --this.logLineSeq, text: line, busy: false })
      }
    }
    return result
  }

  /** Build the dashboard snapshot for the panel. */
  async dashboard(): Promise<InstanceDashboard> {
    await this.ready()
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
        nodeVersion: '',
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
      instances: [...this.runtimes.values()].map((runtime) => runtime.status()),
      active: status,
      activeId: this.activeId,
      issues: this.settings.issues,
    }
  }

  /** Suggest a free port not used by another instance (five-digit base + 1). */
  async suggestPort(): Promise<number | undefined> {
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

  /** Create a new instance; profile initialization is deferred to Start. */
  async create(input: InstanceInput): Promise<InstanceMutation> {
    const result = validateInstance(input, instanceModelOptions(), this.settings.instances)
    if (!result.instance) return { issues: result.issues }
    const home = instanceHome(result.instance, instanceModelOptions())
    try {
      if (fs.existsSync(home) && !fs.statSync(home).isDirectory()) {
        return { issues: [...result.issues, { index: 0, field: 'home', severity: 'error', message: 'home is a file' }] }
      }
      fs.mkdirSync(home, { recursive: true })
    } catch (error) {
      return { issues: [...result.issues, { index: 0, field: 'home', severity: 'error', message: `cannot create home: ${error instanceof Error ? error.message : String(error)}` }] }
    }
    this.settings.instances.push(result.instance)
    this.settings.activeId = result.instance.id
    this.runtimes.set(result.instance.id, new InstanceRuntime(result.instance, this.host))
    await writeInstances(this.settings.instances)
    await writeActiveInstance(result.instance.id)
    return { instance: result.instance, issues: result.issues }
  }

  /** Edit an instance; home/profile/port changes require a stopped runtime. */
  async update(id: string, input: InstanceInput): Promise<InstanceMutation> {
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
    this.settings.instances[index] = result.instance
    runtime?.update(result.instance)
    await writeInstances(this.settings.instances)
    return { instance: result.instance, issues: result.issues }
  }

  /** Remove an instance from the list; its DSH home is never deleted. */
  async remove(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id)
    if (runtime) {
      const status = runtime.status()
      if (status.running || status.starting || status.stopping || status.installing) return false
      runtime.dispose()
      this.runtimes.delete(id)
    }
    this.settings.instances = this.settings.instances.filter((instance) => instance.id !== id)
    if (this.settings.activeId === id) this.settings.activeId = this.settings.instances[0]?.id ?? ''
    await writeInstances(this.settings.instances)
    await writeActiveInstance(this.settings.activeId)
    return true
  }

  /** Start one instance and make it active. */
  async start(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    await this.select(id)
    return runtime.start()
  }

  /** Stop one instance. */
  async stop(id: string): Promise<boolean> {
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
