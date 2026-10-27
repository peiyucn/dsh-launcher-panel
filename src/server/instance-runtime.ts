import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { decodeChildOutput, isProcessAlive, sleep } from '../proc.ts'
import {
  HTTP_PROBE_TIMEOUT_MS,
  PORT_POLL_INTERVAL_MS,
  STOP_POLL_ATTEMPTS,
  STOP_POLL_INTERVAL_MS,
  STOP_POLL_PROBE_MS,
} from '../timing.ts'
import { httpOk, isPortOpen, tokenAccepted } from './probes.ts'
import { findPortOwner, killPid } from './process.ts'
import { dshBaseDir, maskPath, resolveDshHome } from '../paths.ts'
import { instanceHome, instanceLogPath, type DshInstance } from '../instances.ts'
import { holdsHome, nextState, stopDecision, type InstanceEvent, type InstanceState } from '../instance-state.ts'
import { readConfig, type DshConfig } from './config.ts'
import { ensureInstanceBrand, removeInstanceBrand } from './instance-brand.ts'
import { LOG_TAIL_LINES, LogTailPump, readLogTail, readTokenFromLog } from './log-read.ts'
import { buildProfileInitSpec, buildSpawnSpec } from './start-spec.ts'
import { isUpdating } from './update.ts'

const LOOPBACK = '127.0.0.1'

const PROFILE_INIT_TIMEOUT_MS = 180_000

const START_TIMEOUT_MS = 10 * 60_000

/** Whole-start bound: a hung install must surface as error, never leave `starting` behind. */
const START_WATCHDOG_MS = 20 * 60_000

function loopbackUrl(port: number): string {
  return `http://${LOOPBACK}:${port}`
}

function isListening(port: number, probeMs?: number): Promise<boolean> {
  return isPortOpen(LOOPBACK, port, probeMs)
}

function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

export interface PreparedDsh {
  mode: 'pnpm' | 'source'
  version: string
  /** pnpm may be a `.cmd` shim; resolve it before spawning. */
  pnpmCmd?: string
  installDir?: string
  checkout?: string
}

export interface RuntimeHost {
  prepare(): Promise<PreparedDsh | undefined>
  isDshMissing(): boolean
  isHomeRunning(home: string, exceptId: string): boolean
  addActivity: (line: string, isBusy?: boolean) => number
  dbg: (line: string) => void
}

export interface InstanceRuntimeStatus {
  id: string
  name: string
  home: string
  homeShort: string
  profile: string
  port: number
  state: InstanceState
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  /** A server answers on the port but this window does not track its process. */
  adopted: boolean
  /** The port listens while this runtime does not run it: Stop needs consent. */
  untrackedPort: boolean
  error: string
  url: string
  logPath: string
  logPathShort: string
}

function runInitCommand(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: PROFILE_INIT_TIMEOUT_MS,
      encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = `${decodeChildOutput(stdout ?? Buffer.alloc(0))}\n${decodeChildOutput(stderr ?? Buffer.alloc(0))}`.trim()
      if (!error) {
        resolve({ ok: true, output })
        return
      }
      const timedOut = (error as { killed?: boolean }).killed === true
      resolve({ ok: false, output: `${timedOut ? 'timed out' : error.message}\n${output}`.trim() })
    })
  })
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
    return this.host.addActivity(`[${this.instance.name}] ${line}`, busy)
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

  private async probeUrl(): Promise<string | undefined> {
    const plain = `${loopbackUrl(this.instance.port)}/`
    if (await httpOk(plain, HTTP_PROBE_TIMEOUT_MS)) return plain
    const token = readTokenFromLog(this.logPath) ?? readTokenFromLog(this.legacyLogPath)
    if (token === undefined) return undefined
    const tokenUrl = `${plain}?token=${token}`
    return (await tokenAccepted(tokenUrl, HTTP_PROBE_TIMEOUT_MS)) ? tokenUrl : undefined
  }

  /** Pre-multi-instance server log; only an adopted default instance can have one. */
  private get legacyLogPath(): string {
    return path.join(dshBaseDir(), 'logs', 'server.log')
  }

  private async adopt(): Promise<boolean> {
    const url = await this.probeUrl()
    if (url === undefined) return false
    this.url = url
    this.error = ''
    this.consoleLog = []
    this.transition('adopt')
    return true
  }

  /** DSH owns profile creation: `--dump-config` composes the tree and exits. */
  private async ensureProfile(prepared: PreparedDsh, home: string): Promise<boolean> {
    const profileDir = path.join(home, 'profiles', this.instance.profile)
    if (fs.existsSync(profileDir)) return true
    this.activity(`ℹ Initializing profile "${this.instance.profile}" in ${home}…`)
    const built = buildProfileInitSpec({
      ...prepared,
      profile: this.instance.profile,
      home,
      nodePath: this.config().nodePath,
      baseEnv: process.env,
    })
    if (!built.ok) return this.fail(built.reason)
    const result = await runInitCommand(built.spec.file, built.spec.args, built.spec.cwd, built.spec.env)
    if (!result.ok || !fs.existsSync(profileDir)) {
      return this.fail(`profile initialization failed: ${result.output.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || 'no output'}`)
    }
    this.activity(`✓ Profile "${this.instance.profile}" initialized`)
    return true
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

  private async spawnServer(prepared: PreparedDsh, home: string): Promise<boolean> {
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
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
    } catch (error) {
      return this.fail(`cannot create the instance log directory: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (cfg.clearServerLogOnStart ?? true) {
      try { fs.writeFileSync(this.logPath, '') } catch { /* best effort */ }
    }
    let logFd: number
    try {
      logFd = fs.openSync(this.logPath, 'a')
    } catch (error) {
      return this.fail(`cannot open the instance log: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const child = spawn(built.spec.file, built.spec.args, {
        cwd: built.spec.cwd,
        env: built.spec.env,
        windowsHide: cfg.hideConsole ?? true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', logFd, logFd],
      })
      this.child = child
      this.pid = child.pid
      child.unref()
      child.once('error', (error) => {
        if (this.state === 'starting') this.fail(`failed to start: ${error.message}`)
      })
      child.once('close', (code, signal) => {
        this.child = undefined
        // Starting is diagnosed by waitForReady; stopping by stopInternal.
        if (this.state !== 'running') return
        const detail = code !== null ? `exit code ${code}` : signal !== null ? `signal ${signal}` : 'no exit code'
        this.pid = undefined
        this.url = ''
        this.untrackedPort = false
        this.logPump.stop()
        this.error = `dsh exited unexpectedly (${detail}) — see ${this.logPath}`
        this.transition('exit')
        this.activity(`✗ ${this.error}`)
      })
    } catch (error) {
      return this.fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try { fs.closeSync(logFd) } catch { /* child owns the duplicate */ }
    }
    this.logPump.start()
    return true
  }

  private async waitForReady(): Promise<boolean> {
    const startedAt = Date.now()
    for (;;) {
      await sleep(PORT_POLL_INTERVAL_MS)
      if (this.state !== 'starting') return false
      if (Date.now() - startedAt > START_TIMEOUT_MS) {
        this.killTracked()
        return this.fail(`start timed out after ${Math.round(START_TIMEOUT_MS / 60_000)} minutes`)
      }
      const url = await this.probeUrl()
      if (url !== undefined) {
        if (this.state !== 'starting') return false
        this.url = url
        this.transition('ready')
        this.activity(`✓ Started ${url.replace(/\?token=.*$/, '')}`)
        return true
      }
      if (this.pid !== undefined && !isProcessAlive(this.pid)) {
        const tail = readLogTail(this.logPath, 5).join(' ')
        return this.fail(`exited before opening port${tail ? `: ${tail}` : ''}`)
      }
    }
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
    if (child?.pid) killPid(child.pid, this.host.dbg)
    if (pid !== undefined) killPid(pid, this.host.dbg)
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
