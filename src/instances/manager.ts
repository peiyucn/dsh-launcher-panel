import * as fs from 'node:fs'
import * as net from 'node:net'
import * as vscode from 'vscode'
import { MIN_INSTANCE_PORT_BASE } from '../shared/env.ts'
import {
  instanceHome,
  nextPort,
  resolveActiveId,
  sameHome,
  validateInstance,
  type DshInstance,
  type InstanceInput,
  type InstanceIssue,
  type NormalizedInstances,
} from './model.ts'
import type { ActivityEntry } from '../shared/activity.ts'
import { addActivity, clearInstanceConsole, dbg, getActivity, replayInstanceActivity } from '../shared/activity.ts'
import { readConfig } from '../dsh/config.ts'
import type { DshUpdate } from '../dsh/update.ts'
import { InstanceRuntime } from './runtime/runtime.ts'
import type { InstanceRuntimeStatus, PreparedDsh, RuntimeHost } from './runtime/types.ts'
import { settingsWriteFailure } from './bootstrap.ts'
import { instanceModelOptions, markInstancesAuthoritative, readInitialInstances, readInstanceSettings, writeActiveInstance, writeInstances } from './store.ts'
import { SharedDsh } from './shared-dsh.ts'
import { buildDashboard, type DashboardFacts, type InstanceDashboard } from './dashboard.ts'

export type { InstanceDashboard } from './dashboard.ts'

interface InstanceMutation {
  instance?: DshInstance
  issues: InstanceIssue[]
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
  private readonly shared: SharedDsh
  private readyPromise: Promise<void> | undefined
  private readyError = ''
  private logLineSeq = 0

  constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState'>) {
    this.shared = new SharedDsh(() => !this.anyActive())
    this.host = {
      prepare: () => this.prepare(),
      isDshMissing: () => this.shared.isDshMissing(),
      isHomeRunning: (home, exceptId) => this.isHomeRunning(home, exceptId),
      addActivity: (line, isBusy, instanceId) => addActivity(line, isBusy, instanceId),
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
    await this.shared.loadNodeVersion()
    for (const issue of this.settings.issues) addActivity(`⚠ ${issue.message}`)
  }

  /** Match runtimes to settings by id: a runtime owns its child and log pump, so it must be reused. */
  private applySettings(next: NormalizedInstances, keepActiveId?: string): void {
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
    this.settings = { ...next, activeId: resolveActiveId(next.instances, keepActiveId, next.activeId) }
    this.runtimes = runtimes
    for (const instance of next.instances) {
      if (!previous.has(instance.id)) replayInstanceActivity(instance.id)
    }
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
    await this.shared.refreshDetection()
  }

  invalidateDetection(): void {
    this.shared.invalidateDetection()
  }

  checkUpdate(force = false): Promise<DshUpdate | undefined> {
    return this.shared.checkUpdate(force)
  }

  activityFor(id: string): ActivityEntry[] {
    const result: ActivityEntry[] = [...getActivity(id)]
    const runtime = this.runtimes.get(id)
    const lines = runtime?.consoleLines() ?? []
    if (runtime && lines.length > 0) {
      result.push({ id: --this.logLineSeq, text: `── ${runtime.instance.name} startup output ──`, busy: false })
      for (const line of lines) result.push({ id: --this.logLineSeq, text: line, busy: false })
    }
    return result
  }

  async dashboard(): Promise<InstanceDashboard> {
    return buildDashboard({
      ready: () => this.ready(),
      refresh: () => this.refresh(),
      facts: () => this.dashboardFacts(),
    })
  }

  private dashboardFacts(): DashboardFacts {
    return {
      instances: this.instanceStatuses(),
      activeId: this.activeId,
      issues: this.issues(),
      checking: this.shared.checkingUpdate,
      update: this.shared.update,
      dsh: this.shared.dshState,
      dshVersion: this.shared.dshVersion,
      dshPath: this.shared.dshPath,
      nodeVersion: this.shared.nodeVersion,
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

  async stop(id: string): Promise<boolean> {
    await this.ready()
    return (await this.runtimes.get(id)?.stop()) ?? false
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
    return this.shared.prepare()
  }

  async updateDsh(): Promise<void> {
    if (this.anyActive()) throw new Error('Stop all instances before updating dsh')
    await this.shared.runUpdate()
    this.shared.invalidateDetection()
    await this.refresh()
    await this.checkUpdate(true)
  }

  /** Stop log pumps; running DSH processes are intentionally left alone. */
  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose()
  }

  /** Clear one instance's server log and its scoped launcher log/feed. */
  clearConsole(id: string): void {
    if (id === '') return
    this.runtimes.get(id)?.clearLog()
    clearInstanceConsole(id)
  }

  async reloadSettings(): Promise<void> {
    await this.ready().catch(() => undefined)
    // Keep this window's active instance: the settings file is shared by every
    // window on the machine, so another window's choice must not switch our tab.
    this.applySettings(readInstanceSettings(), this.activeId)
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
