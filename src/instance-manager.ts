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
import { addActivity, activityLogFile, dbg, fileSizeSafe, getActivity, withBusy } from './server/activity.ts'
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
  unreachablePkgPath as unreachablePkgPathSetting,
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

interface InstanceDashboard {
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

interface InstanceMutation {
  instance?: DshInstance
  issues: InstanceIssue[]
}

const terminalHost: TerminalHost = { addActivity }

/** Host members shared by the install/checkout/update builders. */
const flowHost = {
  addActivity,
  withBusy,
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) =>
    runInTerminalInner(title, command, args, terminalHost, env),
}

let activeManager: InstanceManager | undefined

export function setInstanceManager(manager: InstanceManager): void {
  activeManager = manager
}

export function getInstanceManager(): InstanceManager | undefined {
  return activeManager
}

export class InstanceManager {
  private settings: NormalizedInstances = { instances: [], activeId: '', issues: [] }
  private runtimes = new Map<string, InstanceRuntime>()
  private readonly host: RuntimeHost
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
    this.host = {
      prepare: () => this.prepare(),
      isDshMissing: () => this.dshState === 'missing',
      isHomeRunning: (home, exceptId) => this.isHomeRunning(home, exceptId),
      addActivity,
      dbg,
    }
  }

  /** A failed load stays retryable: caching the rejection would blank the panel for the session. */
  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    const attempt = this.initialize()
    this.readyPromise = attempt
    attempt.catch((error) => {
      this.readyError = errorMessage(error)
      if (this.readyPromise === attempt) this.readyPromise = undefined
    })
    return attempt
  }

  private async initialize(): Promise<void> {
    this.readyError = ''
    this.applySettings(await readInitialInstances(this.context))
    this.nodeVersion = await probeNodeVersion(readConfig().nodePath).catch(() => '')
    for (const issue of this.settings.issues) addActivity(`⚠ ${issue.message}`)
  }

  /** Match runtimes to settings by id: a runtime owns its child and log pump, so it must be reused. */
  private applySettings(next: NormalizedInstances): void {
    const previous = this.runtimes
    const runtimes = new Map<string, InstanceRuntime>()
    for (const instance of next.instances) {
      const existing = previous.get(instance.id)
      if (existing) existing.update(instance)
      runtimes.set(instance.id, existing ?? new InstanceRuntime(instance, this.host))
    }
    for (const [id, runtime] of previous) {
      if (!runtimes.has(id)) runtime.dispose()
    }
    this.settings = next
    this.runtimes = runtimes
  }

  private get activeId(): string {
    if (this.settings.activeId && this.runtimes.has(this.settings.activeId)) return this.settings.activeId
    return this.settings.instances[0]?.id ?? ''
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

  activeInstanceId(): string {
    return this.activeId
  }

  /** Synchronous on purpose: the panel's fallback render must not fail with the rest of a refresh. */
  instanceStatuses(): InstanceRuntimeStatus[] {
    return [...this.runtimes.values()].map((runtime) => runtime.status())
  }

  activeInstance(): DshInstance | undefined {
    const id = this.activeId
    return this.settings.instances.find((instance) => instance.id === id)
  }

  instance(id: string): DshInstance | undefined {
    return this.settings.instances.find((instance) => instance.id === id)
  }

  statusOf(id: string): InstanceRuntimeStatus | undefined {
    return this.runtimes.get(id)?.status()
  }

  uiUrl(id: string): string | undefined {
    return this.runtimes.get(id)?.uiUrl()
  }

  async select(id: string): Promise<void> {
    await this.ready()
    if (!this.runtimes.has(id)) return
    this.settings.activeId = id
    await this.persistActiveId(id)
  }

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
    const lastUpdateCheck = this.updateCache?.at ?? this.updateCheckedAt
    if (!this.checkingUpdate && Date.now() - lastUpdateCheck > UPDATE_CHECK_TTL_MS) void this.checkUpdate()
  }

  invalidateDetection(): void {
    this.detectionAt = 0
  }

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
        addActivity(`⚠ Update check failed: ${errorMessage(error)}`)
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
      ...flowHost,
      readConfig: () => readConfig(),
      findSourceCheckout: () => findSourceCheckout(readConfig()),
      dbg,
      isStopped: () => !this.anyActive(),
      invalidateUpdateCache: () => { this.updateCache = undefined },
      installHost: this.installHost(),
      checkoutHost: this.checkoutHost(),
    }
  }

  activityFor(id: string): ActivityEntry[] {
    const result: ActivityEntry[] = getActivity().map((entry) => ({ ...entry }))
    const runtime = this.runtimes.get(id)
    const lines = runtime?.consoleLines() ?? []
    if (runtime && lines.length > 0) {
      result.push({ id: --this.logLineSeq, text: `── ${runtime.instance.name} startup output ──`, busy: false })
      for (const line of lines) result.push({ id: --this.logLineSeq, text: line, busy: false })
    }
    return result
  }

  async dashboard(): Promise<InstanceDashboard> {
    try {
      await this.ready()
    } catch {
      // readyError is reported through issues() below.
    }
    await this.refresh()
    const cfg = readConfig()
    const instances = this.instanceStatuses()
    const activeId = this.activeId
    const active = instances.find((instance) => instance.id === activeId)
    const consoleLogPath = activityLogFile()
    return {
      status: {
        running: active?.running ?? false,
        starting: active?.starting ?? false,
        installing: active?.installing ?? false,
        stopping: active?.stopping ?? false,
        checking: this.checkingUpdate,
        updating: isUpdating(),
        url: active?.url ?? '',
        dsh: this.dshState,
        dshVersion: this.dshVersion,
        dshPath: this.dshPath,
        dshHome: active?.home ?? '',
        dshPathShort: maskPath(this.dshPath),
        dshHomeShort: maskPath(active?.home ?? ''),
        nodeVersion: this.nodeVersion,
        mode: cfg.runMode,
        update: this.updateCache?.update,
        consoleLogPath,
        consoleLogPathShort: maskPath(consoleLogPath),
        serverLogPath: active?.logPath ?? '',
        serverLogPathShort: active?.logPathShort ?? '',
        consoleLogSize: fileSizeSafe(consoleLogPath),
        serverLogSize: active ? fileSizeSafe(active.logPath) : 0,
        sourceDebug: cfg.sourceDebug,
      },
      instances,
      active,
      activeId,
      issues: this.issues(),
    }
  }

  async suggestPort(): Promise<number | undefined> {
    await this.ready()
    const used = new Set(this.settings.instances.map((instance) => instance.port))
    let candidate = nextPort(used, readConfig().instancePortBase + 1) ?? nextPort(used, MIN_INSTANCE_PORT_BASE)
    while (candidate !== undefined) {
      if (await isPortFree(candidate)) return candidate
      used.add(candidate)
      candidate = nextPort(used, candidate + 1)
    }
    return undefined
  }

  private saveIssue(detail: string): InstanceIssue {
    return issue('entry', `could not save the instance list to VS Code settings: ${detail} — `
      + 'reload the window if the extension was just installed or updated, then try again')
  }

  /** Persist before committing to memory: a failed save must not leave a phantom instance behind. */
  async create(input: InstanceInput): Promise<InstanceMutation> {
    await this.ready()
    const result = validateInstance(input, instanceModelOptions(), this.settings.instances)
    if (!result.instance) return { issues: result.issues }
    const instance = result.instance
    const home = instanceHome(instance, instanceModelOptions())
    try {
      if (fs.existsSync(home) && !fs.statSync(home).isDirectory()) {
        return { issues: [...result.issues, issue('home', 'home is a file')] }
      }
      fs.mkdirSync(home, { recursive: true })
    } catch (error) {
      return { issues: [...result.issues, issue('home', `cannot create home: ${errorMessage(error)}`)] }
    }
    const next = [...this.settings.instances, instance]
    const saveError = await this.writeList(next)
    if (saveError !== undefined) return { issues: [...result.issues, this.saveIssue(saveError)] }
    this.settings.activeId = instance.id
    if (!this.runtimes.has(instance.id)) this.runtimes.set(instance.id, new InstanceRuntime(instance, this.host))
    await this.persistActiveId(instance.id)
    return { instance, issues: result.issues }
  }

  async update(id: string, input: InstanceInput): Promise<InstanceMutation> {
    await this.ready()
    if (!this.settings.instances.some((instance) => instance.id === id)) return { issues: [issue('entry', 'instance not found')] }
    if (this.isBusy(id)) return { issues: [issue('entry', 'stop the instance before editing it')] }
    const result = validateInstance(input, instanceModelOptions(), this.settings.instances, id)
    if (!result.instance) return { issues: result.issues }
    const instance = result.instance
    const next = this.settings.instances.map((entry) => (entry.id === id ? instance : entry))
    const saveError = await this.writeList(next)
    if (saveError !== undefined) return { issues: [...result.issues, this.saveIssue(saveError)] }
    this.runtimes.get(id)?.update(instance)
    return { instance, issues: result.issues }
  }

  async remove(id: string): Promise<boolean> {
    await this.ready()
    if (this.isBusy(id)) return false
    if (!this.settings.instances.some((instance) => instance.id === id)) return false
    const next = this.settings.instances.filter((instance) => instance.id !== id)
    const nextActiveId = this.settings.activeId === id ? (next[0]?.id ?? '') : this.settings.activeId
    const saveError = await this.writeList(next)
    if (saveError !== undefined) {
      addActivity(`✗ could not remove the instance: ${saveError}`)
      return false
    }
    await this.persistActiveId(nextActiveId)
    this.runtimes.get(id)?.dispose()
    this.runtimes.delete(id)
    this.settings.activeId = nextActiveId
    // An empty list is a decision, not a first run; remember it so Default is not resurrected.
    if (next.length === 0) await markInstancesAuthoritative(this.context)
    return true
  }

  async start(id: string): Promise<boolean> {
    await this.ready()
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    await this.select(id)
    return runtime.start()
  }

  /** `killUntracked` must be granted by the user (see `stopNeedsConfirmation`). */
  async stop(id: string, killUntracked = false): Promise<boolean> {
    await this.ready()
    return (await this.runtimes.get(id)?.stop(killUntracked)) ?? false
  }

  async stopNeedsConfirmation(id: string): Promise<boolean> {
    await this.ready()
    return (await this.runtimes.get(id)?.needsStopConfirmation()) ?? false
  }

  anyActive(): boolean {
    return [...this.runtimes.values()].some((runtime) => {
      const status = runtime.status()
      return status.running || status.starting || status.installing || status.stopping
    })
  }

  /** A stopping runtime still owns its child, and an error one can hold a live child or port. */
  isHomeRunning(home: string, exceptId: string): boolean {
    for (const [id, runtime] of this.runtimes) {
      if (id !== exceptId && runtime.holdsHome() && sameHome(runtime.status().home, home)) return true
    }
    return false
  }

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
    // A pkgPath synced from another machine may not exist here; say so instead of
    // silently installing into the managed location.
    const unreachable = cfg.runMode === 'pnpm' ? unreachablePkgPathSetting(cfg) : undefined
    if (unreachable !== undefined) {
      addActivity(`⚠ dsh.pkgPath ${maskPath(unreachable)} is not reachable on this machine — using the managed install location (clear the setting to drop this warning)`)
    }
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
      ...flowHost,
      runInstalling: (task) => task(),
      setDshVersion: (version) => { this.dshVersion = version },
      setDshState: (state) => { this.dshState = state },
      dbg,
    }
  }

  private checkoutHost(): CheckoutHost {
    return { ...flowHost, runInstalling: (task) => task() }
  }

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

  clearConsole(id: string): void {
    this.runtimes.get(id)?.clearLog()
  }

  async reloadSettings(): Promise<void> {
    await this.ready().catch(() => undefined)
    this.applySettings(readInstanceSettings())
  }

  homeOf(instance: DshInstance): string {
    return instanceHome(instance, instanceModelOptions())
  }

  private isBusy(id: string): boolean {
    const status = this.runtimes.get(id)?.status()
    return status !== undefined && (status.running || status.starting || status.stopping || status.installing)
  }

  /** Write the list, then commit it to memory; resolves to the failure reason instead of throwing. */
  private async writeList(next: DshInstance[]): Promise<string | undefined> {
    const error = await writeResult(writeInstances(next))
    if (error === undefined) this.settings.instances = next
    return error
  }

  private async persistActiveId(id: string): Promise<void> {
    const error = await writeResult(writeActiveInstance(id))
    if (error !== undefined) addActivity(`⚠ could not remember the active instance: ${error}`)
  }
}

function issue(field: InstanceIssue['field'], message: string): InstanceIssue {
  return { index: 0, field, severity: 'error', message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function writeResult(write: PromiseLike<void>): Promise<string | undefined> {
  try {
    await write
    return undefined
  } catch (error) {
    return settingsWriteFailure(error)
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}
