import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { isProcessAlive, sleep } from '../../shared/proc.ts'
import { STOP_POLL_ATTEMPTS, STOP_POLL_INTERVAL_MS, STOP_POLL_PROBE_MS } from '../../shared/timing.ts'
import { dshBaseDir, maskPath, resolveDshHome } from '../../dsh/paths.ts'
import { instanceHome, instanceLogPath, type DshInstance } from '../model.ts'
import { holdsHome, nextState, stopDecision, type InstanceEvent, type InstanceState } from '../state.ts'
import { readConfig, type DshConfig } from '../../dsh/config.ts'
import { isUpdating } from '../../dsh/update.ts'
import { buildSpawnSpec } from '../../dsh/start-spec.ts'
import { LOG_TAIL_LINES } from '../../shared/logs.ts'
import { ensureInstanceBrand, removeInstanceBrand } from './brand.ts'
import { adoptServer, isListening, loopbackUrl, waitForReady } from './health.ts'
import { LogTailPump } from './log-pump.ts'
import { ensureProfile } from './profile.ts'
import { findPortOwner, killPid } from './process.ts'
import { killTrackedProcess, spawnServer } from './spawn.ts'
import type { InstanceRuntimeStatus, PreparedDsh, RuntimeHost } from './types.ts'

export type { InstanceRuntimeStatus, PreparedDsh, RuntimeHost } from './types.ts'

/** Whole-start bound: a hung install must surface as error, never leave `starting` behind. */
const START_WATCHDOG_MS = 20 * 60_000

function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

export class InstanceRuntime {
  instance: DshInstance

  private readonly host: RuntimeHost
  private readonly logPump: LogTailPump
  private state: InstanceState = 'stopped'
  private installing = false
  private error = ''
  private child: ChildProcess | undefined
  private pid: number | undefined
  private url = ''
  private startPromise: Promise<boolean> | undefined
  private startWatchdog: ReturnType<typeof setTimeout> | undefined
  private stopPromise: Promise<boolean> | undefined
  private untrackedPort = false
  private consoleLog: string[] = []

  constructor(instance: DshInstance, host: RuntimeHost) {
    this.instance = instance
    this.host = host
    this.logPump = new LogTailPump(() => this.logSource())
  }

  update(instance: DshInstance): void {
    this.instance = instance
  }

  private resolveHome(): string {
    return instanceHome(this.instance, { homeDir: os.homedir(), defaultHome: resolveDshHome() })
  }

  get logPath(): string {
    return instanceLogPath(dshBaseDir(), this.instance.id)
  }

  private activity(line: string, busy = false): number {
    return this.host.addActivity(`[${this.instance.name}] ${line}`, busy, this.instance.id)
  }

  private config(): DshConfig {
    return { ...readConfig(), port: this.instance.port }
  }

  private transition(event: InstanceEvent): void {
    const next = nextState(this.state, event)
    if (next === undefined) {
      this.host.dbg(`[${this.instance.id}] ignored state transition ${this.state} --${event}-->`)
      return
    }
    // Freeze what this start captured: a running dsh keeps logging plugin chatter.
    if (this.state === 'starting' && next !== 'starting') {
      this.consoleLog = this.logPump.tail(LOG_TAIL_LINES)
      this.logPump.stop()
    }
    this.state = next
  }

  /** Pre-multi-instance server log; only an adopted default instance can have one. */
  private get legacyLogPath(): string {
    return path.join(dshBaseDir(), 'logs', 'server.log')
  }

  private adopt(): Promise<boolean> {
    return adoptServer(this.instance.port, this.logPath, this.legacyLogPath, {
      setUrl: (url) => { this.url = url },
      clearError: () => { this.error = '' },
      clearConsoleLog: () => { this.consoleLog = [] },
      adopt: () => this.transition('adopt'),
    })
  }

  private ensureProfile(prepared: PreparedDsh, home: string): Promise<boolean> {
    return ensureProfile(this.instance, prepared, home, {
      activity: (line) => { this.activity(line) },
      fail: (message) => this.fail(message),
      nodePath: () => this.config().nodePath,
    })
  }

  private fail(message: string): false {
    this.error = message
    // A dead pid must not keep reserving the home in `holdsHome`.
    if (this.pid !== undefined && !isProcessAlive(this.pid)) this.pid = undefined
    this.transition('fail')
    this.activity(`✗ ${message}`)
    return false
  }

  private hasTrackedChild(): boolean {
    return this.child !== undefined || this.pid !== undefined
  }

  private spawnServer(prepared: PreparedDsh, home: string): boolean {
    const cfg = this.config()
    const built = buildSpawnSpec({
      ...prepared,
      profile: this.instance.profile,
      port: this.instance.port,
      home,
      nodePath: cfg.nodePath,
      sourceDebug: cfg.sourceDebug,
      baseEnv: process.env,
    })
    if (!built.ok) return this.fail(built.reason)
    return spawnServer(built.spec, {
      state: () => this.state,
      logPath: () => this.logPath,
      clearServerLogOnStart: () => cfg.clearServerLogOnStart ?? true,
      hideConsole: () => cfg.hideConsole ?? true,
      fail: (message) => this.fail(message),
      setChild: (child) => { this.child = child },
      setPid: (pid) => { this.pid = pid },
      handleUnexpectedExit: (code, signal) => this.handleUnexpectedExit(code, signal),
      startLogPump: () => this.logPump.start(),
    })
  }

  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = code !== null ? `exit code ${code}` : signal !== null ? `signal ${signal}` : 'no exit code'
    this.pid = undefined
    this.url = ''
    this.untrackedPort = false
    this.logPump.stop()
    this.error = `dsh exited unexpectedly (${detail}) — see ${this.logPath}`
    this.transition('exit')
    this.activity(`✗ ${this.error}`)
  }

  private waitForReady(): Promise<boolean> {
    return waitForReady(this.instance.port, {
      state: () => this.state,
      pid: () => this.pid,
      logPath: () => this.logPath,
      legacyLogPath: () => this.legacyLogPath,
      activity: (line) => { this.activity(line) },
      fail: (message) => this.fail(message),
      transition: (event) => this.transition(event),
      setUrl: (url) => { this.url = url },
      killTracked: () => this.killTracked(),
    })
  }

  private async startInternal(): Promise<boolean> {
    try {
      return await this.startFlow()
    } catch (error) {
      this.installing = false
      if (this.state === 'starting') {
        this.killTracked()
        this.logPump.stop()
      }
      return this.fail(`start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async startFlow(): Promise<boolean> {
    const cfg = this.config()
    if (await isListening(cfg.port)) {
      return (await this.adopt()) || this.fail(`port ${cfg.port} is already in use by another process`)
    }
    if (this.host.isHomeRunning(this.resolveHome(), this.instance.id)) {
      return this.fail('another instance with the same home is running')
    }
    if (isUpdating()) return this.fail('a dsh update is in progress — wait for it to finish')
    this.error = ''
    this.consoleLog = []
    this.untrackedPort = false
    this.transition('start')
    const home = this.resolveHome()
    try {
      fs.mkdirSync(home, { recursive: true })
    } catch (error) {
      return this.fail(`cannot create home ${home}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Only say Installing when dsh is really missing, or every Start flashes it.
    this.installing = this.host.isDshMissing()
    let prepared: PreparedDsh | undefined
    try {
      prepared = await this.host.prepare()
    } finally {
      this.installing = false
    }
    if (prepared === undefined) return this.fail('dsh install or detection failed — see the launcher log')
    if (this.state !== 'starting') return false
    if (!(await this.ensureProfile(prepared, home))) return false
    if (this.state !== 'starting') return false
    try {
      if (cfg.instanceBrand) ensureInstanceBrand(home, this.instance.profile, this.instance.name)
      else removeInstanceBrand(home, this.instance.profile)
    } catch (error) {
      this.activity(`⚠ Instance brand skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!(await this.spawnServer(prepared, home))) return false
    return this.waitForReady()
  }

  start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise
    if (this.state === 'running') {
      void this.adopt()
      return Promise.resolve(true)
    }
    if (this.state === 'stopping') return Promise.resolve(false)
    this.clearStartWatchdog()
    this.startWatchdog = setTimeout(() => {
      this.startWatchdog = undefined
      if (this.state !== 'starting') return
      this.installing = false
      this.killTracked()
      this.logPump.stop()
      this.fail(`start timed out after ${Math.round(START_WATCHDOG_MS / 60_000)} minutes — the launcher stopped waiting for DSH`)
    }, START_WATCHDOG_MS)
    this.startPromise = this.startInternal().finally(() => {
      this.clearStartWatchdog()
      this.startPromise = undefined
      this.installing = false
    })
    return this.startPromise
  }

  private clearStartWatchdog(): void {
    if (this.startWatchdog !== undefined) {
      clearTimeout(this.startWatchdog)
      this.startWatchdog = undefined
    }
  }

  private killTracked(): void {
    const child = this.child
    const pid = this.pid
    this.child = undefined
    this.pid = undefined
    killTrackedProcess(child, pid, this.host.dbg)
  }

  /** Whether Stop would have to kill a process this window did not spawn. */
  async needsStopConfirmation(): Promise<boolean> {
    if (this.hasTrackedChild()) return false
    return isListening(this.instance.port, STOP_POLL_PROBE_MS)
  }

  private finishStopped(): true {
    this.url = ''
    this.error = ''
    this.untrackedPort = false
    this.transition('stop-complete')
    this.activity('■ Stopped')
    return true
  }

  private async stopInternal(killUntracked: boolean): Promise<boolean> {
    this.clearStartWatchdog()
    this.installing = false
    const tracked = this.hasTrackedChild()
    const portOpen = tracked ? false : await isListening(this.instance.port, STOP_POLL_PROBE_MS)
    const decision = stopDecision({ hasTrackedChild: tracked, portOpen, killUntracked })
    if (decision === 'ask') {
      this.untrackedPort = true
      this.error = `port ${this.instance.port} is held by a process the launcher did not start — confirm before stopping it`
      this.activity(`⚠ ${this.error}`)
      return false
    }
    if (decision === 'cleanup') {
      this.untrackedPort = false
      if (this.state === 'stopped') return false
      this.url = ''
      this.error = ''
      this.logPump.stop()
      this.transition('cleanup')
      this.activity('■ Stopped')
      return true
    }
    this.transition('stop')
    this.killTracked()
    this.logPump.stop()
    if (killUntracked) {
      const owner = await findPortOwner(this.instance.port)
      if (owner !== undefined && owner !== process.pid) killPid(owner, this.host.dbg)
    }
    for (let i = 0; i < STOP_POLL_ATTEMPTS; i++) {
      await sleep(STOP_POLL_INTERVAL_MS)
      if (!(await isListening(this.instance.port, STOP_POLL_PROBE_MS))) return this.finishStopped()
    }
    const stillOpen = await isListening(this.instance.port, STOP_POLL_PROBE_MS)
    if (stillOpen) {
      this.untrackedPort = true
      return this.fail(`could not stop: port ${this.instance.port} is still in use`)
    }
    return this.finishStopped()
  }

  /** `killUntracked` is only passed by a caller that obtained the user's consent. */
  stop(killUntracked = false): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopInternal(killUntracked).finally(() => {
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  async refresh(): Promise<void> {
    if (this.state === 'starting' || this.state === 'stopping') return
    const open = await isListening(this.instance.port)
    if (open) {
      if (this.state === 'running') {
        this.untrackedPort = false
        return
      }
      this.untrackedPort = !(await this.adopt())
      return
    }
    this.untrackedPort = false
    if (this.state !== 'running') return
    this.url = ''
    this.logPump.stop()
    this.transition('lost')
  }

  private logSource(): string {
    if (this.instance.home !== '' || !this.isAdopted()) return this.logPath
    if ((statOrUndefined(this.logPath)?.size ?? 0) > 0) return this.logPath
    return statOrUndefined(this.legacyLogPath) !== undefined ? this.legacyLogPath : this.logPath
  }

  /** While starting, live lines; afterwards the startup output frozen at settle time. */
  consoleLines(maxLines = LOG_TAIL_LINES): string[] {
    return this.state === 'starting' ? this.logPump.tail(maxLines) : this.consoleLog.slice(-maxLines)
  }

  clearLog(): void {
    this.logPump.reset()
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
      fs.writeFileSync(this.logPath, '')
    } catch {
      // Best effort; a running server may hold the file.
    }
    this.consoleLog = []
    if (this.state === 'starting') this.logPump.start()
  }

  dispose(): void {
    this.clearStartWatchdog()
    this.logPump.stop()
  }

  status(): InstanceRuntimeStatus {
    const home = this.resolveHome()
    return {
      id: this.instance.id,
      name: this.instance.name,
      home,
      homeShort: maskPath(home),
      profile: this.instance.profile,
      port: this.instance.port,
      state: this.state,
      running: this.state === 'running',
      starting: this.state === 'starting',
      installing: this.installing,
      stopping: this.state === 'stopping',
      adopted: this.isAdopted(),
      untrackedPort: this.untrackedPort,
      error: this.error,
      url: loopbackUrl(this.instance.port),
      logPath: this.logPath,
      logPathShort: maskPath(this.logPath),
    }
  }

  /** Not a status field: status objects reach the webview, which must not get the token. */
  uiUrl(): string {
    return this.url || loopbackUrl(this.instance.port)
  }

  isAdopted(): boolean {
    return this.state === 'running' && this.child === undefined
  }

  holdsHome(): boolean {
    return holdsHome(this.state, this.hasTrackedChild(), this.untrackedPort)
  }
}
