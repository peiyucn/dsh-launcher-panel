/**
 * One running (or stopped) DSH instance.
 *
 * This is the per-instance replacement for the old single-server lifecycle:
 * every instance owns its child handle, pid, phase, URL, log path and start/stop
 * locks. Install/detect remain shared and are reached through {@link RuntimeHost}
 * so two instances never race a package install.
 *
 * The launcher deliberately drives DSH only through its public CLI
 * (`dsh <profile> --port …`, `--dump-config` for profile initialization); it
 * never copies a profile template. The one exception is the optional instance
 * branding bundle (see `instance-brand.ts`), which is a launcher-generated local
 * client bundle added to the profile's bundle list.
 *
 * State moves go through the pure table in `instance-state.ts`; command and
 * environment construction lives in `server/start-spec.ts`, log tail reads in
 * `server/log-read.ts` (both unit-tested without VS Code).
 *
 * @module server/instance-runtime
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { decodeChildOutput, isProcessAlive, sleep } from '../proc.ts'
import { HTTP_PROBE_TIMEOUT_MS, LOG_TAIL_POLL_MS, PORT_POLL_INTERVAL_MS, STOP_POLL_ATTEMPTS, STOP_POLL_INTERVAL_MS, STOP_POLL_PROBE_MS } from '../timing.ts'
import { httpOk, isPortOpen, tokenAccepted } from './probes.ts'
import { findPortOwner, killPid } from './process.ts'
import { dshBaseDir, maskPath, resolveDshHome } from '../paths.ts'
import { instanceHome, instanceLogPath, type DshInstance } from '../instances.ts'
import { holdsHome, nextState, stopDecision, type InstanceEvent, type InstanceState } from '../instance-state.ts'
import { readConfig, type DshConfig } from './config.ts'
import { ensureInstanceBrand, removeInstanceBrand } from './instance-brand.ts'
import { LOG_READ_BYTES, LOG_TAIL_LINES, readLogTail, readTokenFromLog } from './log-read.ts'
import { buildProfileInitSpec, buildSpawnSpec } from './start-spec.ts'
import { isUpdating } from './update.ts'

/** What a prepared shared install supplies to an instance start. */
export interface PreparedDsh {
  mode: 'pnpm' | 'source'
  version: string
  /** pnpm command for pkg mode (may be a .cmd shim; resolve before spawning). */
  pnpmCmd?: string
  /** Managed package directory for pkg mode. */
  installDir?: string
  /** Source checkout for source mode. */
  checkout?: string
}

/** What the runtime needs from the manager/global install layer. */
export interface RuntimeHost {
  /** Install/detect the shared dsh once; concurrent calls coalesce. */
  prepare(): Promise<PreparedDsh | undefined>
  /** Whether the shared dsh is currently known to be missing (first-run install). */
  isDshMissing(): boolean
  /** Whether another instance with the same normalized home is running or still holding it. */
  isHomeRunning(home: string, exceptId: string): boolean
  /** Append one line to the shared launcher activity feed. */
  addActivity: (line: string, isBusy?: boolean) => number
  /** Diagnostic line to the client log only. */
  dbg: (line: string) => void
}

/** The per-instance status the panel renders for one tab. */
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
  /**
   * A server is answering on the port but this launcher does not track the
   * process (adopted after an extension restart, or started elsewhere).
   */
  adopted: boolean
  /**
   * The port is listening while this runtime is not running it. Stopping in
   * this state would kill a process the launcher did not spawn, so it requires
   * explicit confirmation (see `needsStopConfirmation`).
   */
  untrackedPort: boolean
  error: string
  /** Display URL (never carries the auth token). */
  url: string
  logPath: string
  logPathShort: string
}

/** How long a first profile initialization may take. */
const PROFILE_INIT_TIMEOUT_MS = 180_000

/** A start that never produces an HTTP response must not spin forever. */
const START_TIMEOUT_MS = 10 * 60_000

/**
 * Last-resort bound on a whole start (shared install + profile init + spawn +
 * readiness wait). The individual steps have their own bounds; this one keeps a
 * `starting` instance from staying there forever if one of them never settles.
 */
const START_WATCHDOG_MS = 20 * 60_000

/** The live buffer keeps this many lines before dropping the oldest. */
const LOG_BUFFER_LINES = 500

/** Build a DshConfig view for one instance: shared settings + its port. */
function runtimeConfig(instance: DshInstance): DshConfig {
  return { ...readConfig(), port: instance.port }
}

/** Run a short initialization command with a per-instance DSH_HOME, capturing output. */
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
  private state: InstanceState = 'stopped'
  private installing = false
  private error = ''
  private child: ChildProcess | undefined
  private pid: number | undefined
  private url = ''
  private startPromise: Promise<boolean> | undefined
  private startWatchdog: ReturnType<typeof setTimeout> | undefined
  private stopPromise: Promise<boolean> | undefined
  /** Port is listening but this runtime has no tracked child (Stop needs consent). */
  private untrackedPort = false
  private logBuffer = ''
  private logOffset = 0
  private logLinesCache: string[] = []
  private logTimer: ReturnType<typeof setInterval> | undefined
  private logWatcher: fs.FSWatcher | undefined
  private logSourcePath = ''
  /** The startup output frozen when the current start settled; shown by the panel console. */
  private consoleLog: string[] = []

  constructor(instance: DshInstance, host: RuntimeHost) {
    this.instance = instance
    this.host = host
  }

  /** Update the coordinates after an edit; the caller stops the runtime first. */
  update(instance: DshInstance): void {
    this.instance = instance
  }

  /** The instance home resolved through the shared store model. */
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
    return runtimeConfig(this.instance)
  }

  /**
   * Apply one lifecycle event through the pure transition table. An edge that
   * the table does not allow is a programming error in a failure path; it must
   * not silently invent a state, so it is logged and skipped.
   */
  private transition(event: InstanceEvent): void {
    const next = nextState(this.state, event)
    if (next === undefined) {
      this.host.dbg(`[${this.instance.id}] ignored state transition ${this.state} --${event}-->`)
      return
    }
    this.setState(next)
  }

  private setState(state: InstanceState): void {
    // A start's dsh output is captured once, when it settles. After that the
    // panel console stops following the file: a running dsh writes periodic
    // plugin chatter (model listings and similar) forever, and mirroring the
    // tail kept the launcher console scrolling with messages that are not
    // launcher events. The full log stays in server.log, linked in the panel.
    if (this.state === 'starting' && state !== 'starting') {
      // Only what this start captured: reading the file here could surface an
      // older run's tail when the start failed before it ever spawned.
      this.consoleLog = this.logLinesCache.slice(-LOG_TAIL_LINES)
      this.stopLogPump()
    }
    this.state = state
  }

  /** Resolve the tokenless/display URL currently serving, if any. */
  private async probeUrl(port: number): Promise<string | undefined> {
    const plain = `http://127.0.0.1:${port}/`
    if (await httpOk(plain, HTTP_PROBE_TIMEOUT_MS)) return plain
    const token = readTokenFromLog(this.logPath) ?? readTokenFromLog(this.legacyLogPath)
    if (!token) return undefined
    const tokenUrl = `${plain}?token=${token}`
    return (await tokenAccepted(tokenUrl, HTTP_PROBE_TIMEOUT_MS)) ? tokenUrl : undefined
  }

  /** The pre-multi-instance server log, used only when adopting an old run. */
  private get legacyLogPath(): string {
    return path.join(dshBaseDir(), 'logs', 'server.log')
  }

  /** Adopt a server that outlived the extension host (or was started elsewhere). */
  private async adopt(port: number): Promise<boolean> {
    const url = await this.probeUrl(port)
    if (!url) return false
    this.url = url
    this.error = ''
    // An adopted run was not started by this host, so there is no startup
    // output of ours to show; its log stays in the file.
    this.consoleLog = []
    this.transition('adopt')
    return true
  }

  /**
   * Make sure the instance profile exists. DSH owns profile initialization:
   * `--dump-config` composes the tree and exits, which creates the profile on a
   * fresh home without starting a server.
   */
  private async ensureProfile(prepared: PreparedDsh, home: string): Promise<boolean> {
    const profileDir = path.join(home, 'profiles', this.instance.profile)
    if (fs.existsSync(profileDir)) return true

    this.activity(`ℹ Initializing profile "${this.instance.profile}" in ${home}…`)
    const built = buildProfileInitSpec({
      mode: prepared.mode,
      pnpmCmd: prepared.pnpmCmd,
      installDir: prepared.installDir,
      checkout: prepared.checkout,
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

  /** Record a user-visible failure and leave the runtime in `error`. */
  private fail(message: string): false {
    this.error = message
    // A failure can surface after the child already died (e.g. "exited before
    // opening port"); drop the stale pid so `holdsHome` does not reserve the
    // home for a process that no longer exists.
    if (this.pid !== undefined && !isProcessAlive(this.pid)) this.pid = undefined
    this.transition('fail')
    this.activity(`✗ ${message}`)
    return false
  }

  /** Whether this host is tracking a child process for the instance. */
  private hasTrackedChild(): boolean {
    return this.child !== undefined || this.pid !== undefined
  }

  /**
   * Spawn the DSH web app with the instance's DSH_HOME and port.
   *
   * Any failure here is reported through `fail` (including the log directory):
   * silently rejecting out of `startInternal` left the instance stuck in
   * `starting` forever (spec §8 requires an error instead).
   */
  private async spawnServer(prepared: PreparedDsh, home: string): Promise<boolean> {
    const cfg = this.config()
    const built = buildSpawnSpec({
      mode: prepared.mode,
      version: prepared.version,
      pnpmCmd: prepared.pnpmCmd,
      installDir: prepared.installDir,
      checkout: prepared.checkout,
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
        // While starting, waitForReady owns the diagnosis (it checks the pid);
        // while stopping, stopInternal owns the transition.
        if (this.state === 'running') this.handleUnexpectedExit(code, signal)
      })
    } catch (error) {
      return this.fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try { fs.closeSync(logFd) } catch { /* child owns the duplicate */ }
    }
    this.startLogPump()
    return true
  }

  /**
   * A tracked child died without a Stop asking for it. Report the exit code
   * with the log path, clear the stale pid/URL, and return to `stopped` with the
   * reason kept visible — the process is gone, so claiming `running` or a bare
   * idle state would both be dishonest (spec §8 "意外退出").
   */
  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    const detail = code !== null ? `exit code ${code}` : signal !== null ? `signal ${signal}` : 'no exit code'
    this.pid = undefined
    this.url = ''
    this.untrackedPort = false
    this.stopLogPump()
    this.error = `dsh exited unexpectedly (${detail}) — see ${this.logPath}`
    this.transition('exit')
    this.activity(`✗ ${this.error}`)
  }

  private async waitForReady(port: number): Promise<boolean> {
    const startedAt = Date.now()
    for (;;) {
      await sleep(PORT_POLL_INTERVAL_MS)
      if (this.state !== 'starting') return false
      if (Date.now() - startedAt > START_TIMEOUT_MS) {
        this.killTracked()
        return this.fail(`start timed out after ${Math.round(START_TIMEOUT_MS / 60_000)} minutes`)
      }
      const url = await this.probeUrl(port)
      if (url) {
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

  /**
   * The start flow proper. Split from `start()` so the whole flow — not only
   * the readiness wait — is guarded: an exception anywhere (profile init, log
   * directory, spawn) must surface as `error`, never leave `starting` behind.
   */
  private async startInternal(): Promise<boolean> {
    try {
      return await this.startFlow()
    } catch (error) {
      this.installing = false
      if (this.state === 'starting') {
        // Do not leak a child the failed flow may already have spawned.
        this.killTracked()
        this.stopLogPump()
      }
      return this.fail(`start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async startFlow(): Promise<boolean> {
    const cfg = this.config()
    if (await isPortOpen('127.0.0.1', cfg.port)) {
      if (await this.adopt(cfg.port)) return true
      return this.fail(`port ${cfg.port} is already in use by another process`)
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

    // `prepare()` also detects an already-installed dsh; only expose the
    // Installing state when the shared dsh is actually missing. Otherwise every
    // normal Start flashes "Installing…" even though nothing is installed.
    this.installing = this.host.isDshMissing()
    let prepared: PreparedDsh | undefined
    try {
      prepared = await this.host.prepare()
    } finally {
      this.installing = false
    }
    if (prepared === undefined) {
      return this.fail('dsh install or detection failed — see the launcher log')
    }
    if (this.state !== 'starting') return false

    if (!(await this.ensureProfile(prepared, home))) return false
    if (this.state !== 'starting') return false
    try {
      if (cfg.instanceBrand) ensureInstanceBrand(home, this.instance.profile, this.instance.name)
      else removeInstanceBrand(home, this.instance.profile)
    } catch (error) {
      // Branding must never block Start; fall back to the official wordmark.
      this.activity(`⚠ Instance brand skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!(await this.spawnServer(prepared, home))) return false
    return this.waitForReady(cfg.port)
  }

  /** Start the instance; concurrent calls coalesce. */
  start(): Promise<boolean> {
    if (this.startPromise) return this.startPromise
    if (this.state === 'running') {
      void this.adopt(this.instance.port)
      return Promise.resolve(true)
    }
    if (this.state === 'stopping') return Promise.resolve(false)
    // Independent watchdog: every phase above has its own bound, but a hung
    // install/detection must still not leave the instance in `starting` forever.
    this.clearStartWatchdog()
    this.startWatchdog = setTimeout(() => {
      this.startWatchdog = undefined
      if (this.state !== 'starting') return
      this.installing = false
      this.killTracked()
      this.stopLogPump()
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
    if (this.startWatchdog) {
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

  /**
   * Whether Stop would have to terminate a process this host did not spawn.
   *
   * True for an adopted server (running without a tracked child) and for a
   * stopped/error instance whose configured port is still held by someone.
   * Spec §8/§12 require explicit consent before any port-owner kill.
   */
  async needsStopConfirmation(): Promise<boolean> {
    if (this.hasTrackedChild()) return false
    return isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS)
  }

  /** Finish a Stop that was allowed to kill/see the port close. */
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
    // A Stop during the shared install interrupts that phase from the user's
    // point of view; do not leave "Installing…" painted over a stopped state.
    this.installing = false
    const tracked = this.hasTrackedChild()
    const portOpen = tracked ? false : await isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS)
    const decision = stopDecision({ hasTrackedChild: tracked, portOpen, killUntracked })
    if (decision === 'ask') {
      // P0-1: the port may belong to anything (the user's own server, another
      // launcher, a stale dsh). Kill only after explicit confirmation.
      this.untrackedPort = true
      this.error = `port ${this.instance.port} is held by a process the launcher did not start — confirm before stopping it`
      this.activity(`⚠ ${this.error}`)
      return false
    }
    if (decision === 'cleanup') {
      this.untrackedPort = false
      if (this.state === 'stopped') return false
      // Nothing is tracked and nothing listens: a manual Stop clears a failed
      // start/stop (or interrupts a start still waiting for the shared install)
      // without touching any process.
      this.url = ''
      this.error = ''
      this.stopLogPump()
      this.transition('cleanup')
      this.activity('■ Stopped')
      return true
    }

    this.transition('stop')
    this.killTracked()
    this.stopLogPump()
    if (killUntracked) {
      const owner = await findPortOwner(this.instance.port)
      if (owner !== undefined && owner !== process.pid) killPid(owner, this.host.dbg)
    }
    for (let i = 0; i < STOP_POLL_ATTEMPTS; i++) {
      await sleep(STOP_POLL_INTERVAL_MS)
      if (!(await isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS))) return this.finishStopped()
    }
    const stillOpen = await isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS)
    if (stillOpen) {
      this.untrackedPort = true
      return this.fail(`could not stop: port ${this.instance.port} is still in use`)
    }
    return this.finishStopped()
  }

  /**
   * Stop the instance; repeated calls coalesce.
   *
   * Defaults to not killing a process this runtime does not track: the caller
   * must first ask the user (see `needsStopConfirmation`) and pass `true`.
   */
  stop(killUntracked = false): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopInternal(killUntracked).finally(() => {
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  /** Refresh state from the port; called by the manager on every panel tick. */
  async refresh(): Promise<void> {
    if (this.state === 'starting' || this.state === 'stopping') return
    const open = await isPortOpen('127.0.0.1', this.instance.port)
    if (open) {
      if (this.state === 'running') {
        this.untrackedPort = false
        return
      }
      // A server that outlived the extension host (or another window's) is
      // adopted when its URL/token answers; otherwise it is a foreign listener.
      const adopted = await this.adopt(this.instance.port)
      this.untrackedPort = !adopted
      return
    }
    this.untrackedPort = false
    if (this.state === 'running') {
      this.url = ''
      this.stopLogPump()
      this.transition('lost')
    }
  }

  /** The log currently backing the console: own file, or the legacy file for an adopted default run. */
  private logSource(): string {
    if (this.instance.home === '' && this.isAdopted()) {
      try {
        if (fs.statSync(this.logPath).size > 0) return this.logPath
      } catch {
        // own log not created yet
      }
      try {
        fs.statSync(this.legacyLogPath)
        return this.legacyLogPath
      } catch {
        // no legacy run
      }
    }
    return this.logPath
  }

  /** Start (or restart) the per-instance live log pump into the bounded buffer. */
  private startLogPump(): void {
    this.stopLogPump()
    this.logSourcePath = this.logSource()
    this.logBuffer = ''
    this.logLinesCache = []
    try {
      const stat = fs.statSync(this.logSourcePath)
      this.logOffset = Math.max(0, stat.size - LOG_READ_BYTES)
    } catch {
      this.logOffset = 0
    }
    this.pumpLog()
    try {
      this.logWatcher = fs.watch(this.logSourcePath, () => this.pumpLog())
      this.logWatcher.on('error', () => {})
    } catch {
      this.logWatcher = undefined
    }
    this.logTimer = setInterval(() => this.pumpLog(), LOG_TAIL_POLL_MS)
  }

  private stopLogPump(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer)
      this.logTimer = undefined
    }
    this.logWatcher?.close()
    this.logWatcher = undefined
  }

  /** Read appended bytes into the bounded line buffer. */
  private pumpLog(): void {
    const source = this.logSource()
    if (source !== this.logSourcePath) {
      this.logSourcePath = source
      this.logOffset = 0
      this.logBuffer = ''
      this.logLinesCache = []
    }
    let size: number
    try {
      size = fs.statSync(source).size
    } catch {
      return
    }
    if (size < this.logOffset) this.logOffset = 0
    if (size <= this.logOffset) return
    let fd: number | undefined
    try {
      fd = fs.openSync(source, 'r')
      const buffer = Buffer.alloc(size - this.logOffset)
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.logOffset)
      this.logOffset += read
      this.logBuffer += buffer.subarray(0, read).toString('utf8')
      const lines = this.logBuffer.split(/\r?\n/)
      this.logBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length === 0) continue
        this.logLinesCache.push(line)
        if (this.logLinesCache.length > LOG_BUFFER_LINES) this.logLinesCache.splice(0, this.logLinesCache.length - LOG_BUFFER_LINES)
      }
    } catch {
      // File may be locked mid-write; retry on the next change/poll.
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  /**
   * The dsh output the panel console shows right now.
   *
   * While starting it follows what this start captured live (that is the wait
   * the user is watching); once the start settled it shows the frozen startup
   * output, so a running instance's periodic plugin logging never fills the
   * launcher console. The full log stays in server.log, linked in the panel.
   */
  consoleLines(maxLines = LOG_TAIL_LINES): string[] {
    if (this.state === 'starting') return this.logLinesCache.slice(-maxLines)
    return this.consoleLog.slice(-maxLines)
  }

  /** Truncate the instance server log (Clear). */
  clearLog(): void {
    this.stopLogPump()
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
      fs.writeFileSync(this.logPath, '')
    } catch {
      // best effort; a running server may hold the file
    }
    this.logLinesCache = []
    this.logBuffer = ''
    this.logOffset = 0
    this.consoleLog = []
    // Only a start in progress feeds the console; a running server's output is
    // deliberately not mirrored (see consoleLines).
    if (this.state === 'starting') this.startLogPump()
  }

  /** Stop timers/watchers without touching the DSH process. */
  dispose(): void {
    this.clearStartWatchdog()
    this.stopLogPump()
  }

  status(): InstanceRuntimeStatus {
    const display = `http://127.0.0.1:${this.instance.port}`
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
      url: display,
      logPath: this.logPath,
      logPathShort: maskPath(this.logPath),
    }
  }

  /**
   * The URL to open for this instance (carries the launch token when the
   * current run printed one). Deliberately a method, not a status field: the
   * status object is posted to the webview and must never carry a token.
   */
  uiUrl(): string {
    return this.url || `http://127.0.0.1:${this.instance.port}`
  }

  /** The port is open but the runtime has no child (adopted server). */
  isAdopted(): boolean {
    return this.state === 'running' && this.child === undefined
  }

  /** Whether this runtime still reserves its DSH home (see `instance-state.ts`). */
  holdsHome(): boolean {
    return holdsHome(this.state, this.hasTrackedChild(), this.untrackedPort)
  }
}
