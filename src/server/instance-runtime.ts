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
 * @module server/instance-runtime
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { decodeChildOutput, isProcessAlive, resolveCommandEntry, sleep } from '../proc.ts'
import { extractWebToken } from '../env.ts'
import { DSH_NO_OPEN_MIN_VERSION, dshVersionAtLeast } from '../versions.ts'
import { HTTP_PROBE_TIMEOUT_MS, LOG_TAIL_POLL_MS, PORT_POLL_INTERVAL_MS, STOP_POLL_ATTEMPTS, STOP_POLL_INTERVAL_MS, STOP_POLL_PROBE_MS } from '../timing.ts'
import { httpOk, isPortOpen, tokenAccepted } from './probes.ts'
import { findPortOwner, killPid } from './process.ts'
import { dshBaseDir, maskPath, resolveDshHome } from '../paths.ts'
import { instanceHome, instanceLogPath, type DshInstance } from '../instances.ts'
import { readConfig, type DshConfig } from './config.ts'
import { ensureInstanceBrand, removeInstanceBrand } from './instance-brand.ts'
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
  /** Whether another instance with the same normalized home is running. */
  isHomeRunning(home: string, exceptId: string): boolean
  /** Append one line to the shared launcher activity feed. */
  addActivity: (line: string, isBusy?: boolean) => number
  /** Diagnostic line to the client log only. */
  dbg: (line: string) => void
}

/** Coarse lifecycle state; `installing` is a transient flag on top of `starting`. */
export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

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
  error: string
  /** Display URL (never carries the auth token). */
  url: string
  /** URL to open, carrying the launch token when the run has one. */
  uiUrl: string
  logPath: string
  logPathShort: string
}

/** How long a first profile initialization may take. */
const PROFILE_INIT_TIMEOUT_MS = 180_000

/** A start that never produces an HTTP response must not spin forever. */
const START_TIMEOUT_MS = 10 * 60_000

/** Read at most this much of a log for the console/token tail. */
const LOG_READ_BYTES = 256 * 1024

/** The console keeps this many server-log lines. */
const LOG_TAIL_LINES = 200

/** The live buffer keeps this many lines before dropping the oldest. */
const LOG_BUFFER_LINES = 500

/** Build a DshConfig view for one instance: shared settings + its port. */
function runtimeConfig(instance: DshInstance): DshConfig {
  return { ...readConfig(), port: instance.port }
}

/** Read the last `maxLines` lines of a file without loading a huge log. */
export function readLogTail(file: string, maxLines = LOG_TAIL_LINES): string[] {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - LOG_READ_BYTES)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      const read = fs.readSync(fd, buffer, 0, buffer.length, start)
      const text = buffer.subarray(0, read).toString('utf8')
      return text.split(/\r?\n/).filter((line) => line.length > 0).slice(-maxLines)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

/** The newest launch token printed in a server log, if any. */
export function readTokenFromLog(file: string): string | undefined {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - LOG_READ_BYTES)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      const read = fs.readSync(fd, buffer, 0, buffer.length, start)
      let token: string | undefined
      for (const line of buffer.subarray(0, read).toString('utf8').split(/\r?\n/)) {
        token = extractWebToken(line) ?? token
      }
      return token
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
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
  private stopPromise: Promise<boolean> | undefined
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
    this.setState('running')
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
    const initArgs = this.instance.profile === 'web'
      ? ['web', '--dump-config']
      : ['--profile', this.instance.profile, '--from-default-profile', 'web', '--dump-config']
    const env = { ...process.env, DSH_HOME: home }
    let file: string
    let args: string[]
    let cwd: string

    if (prepared.mode === 'pnpm') {
      if (!prepared.pnpmCmd || !prepared.installDir) return this.fail('profile initialization needs a pnpm install')
      const resolution = resolveCommandEntry(prepared.pnpmCmd)
      if (!resolution.ok) return this.fail(`pnpm cannot be launched (${resolution.reason})`)
      file = resolution.command.file
      args = [...resolution.command.args, '--config.verify-deps-before-run=false', 'exec', 'dsh', ...initArgs]
      cwd = prepared.installDir
    } else {
      if (!prepared.checkout) return this.fail('profile initialization needs a source checkout')
      file = this.config().nodePath || 'node'
      args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...initArgs]
      cwd = prepared.checkout
    }

    const result = await runInitCommand(file, args, cwd, env)
    if (!result.ok || !fs.existsSync(profileDir)) {
      return this.fail(`profile initialization failed: ${result.output.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || 'no output'}`)
    }
    this.activity(`✓ Profile "${this.instance.profile}" initialized`)
    return true
  }

  /** Record a user-visible failure and leave the runtime in `error`. */
  private fail(message: string): false {
    this.error = message
    this.setState('error')
    this.activity(`✗ ${message}`)
    return false
  }

  /** Spawn the DSH web app with the instance's DSH_HOME and port. */
  private async spawnServer(prepared: PreparedDsh, home: string): Promise<boolean> {
    const cfg = this.config()
    const args = [this.instance.profile, '--port', String(this.instance.port)]
    if (prepared.version && dshVersionAtLeast(prepared.version, DSH_NO_OPEN_MIN_VERSION)) args.push('--no-open')
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home }
    if (cfg.runMode === 'source' && cfg.sourceDebug) env.NODE_DEBUG = 'module'

    let file: string
    let fullArgs: string[]
    let cwd: string
    if (prepared.mode === 'pnpm') {
      if (!prepared.pnpmCmd || !prepared.installDir) return this.fail('pkg start has no pnpm install')
      const resolution = resolveCommandEntry(prepared.pnpmCmd)
      if (!resolution.ok) return this.fail(`pnpm cannot be launched (${resolution.reason})`)
      file = resolution.command.file
      fullArgs = [...resolution.command.args, '--config.verify-deps-before-run=false', 'exec', 'dsh', ...args]
      cwd = prepared.installDir
    } else {
      if (!prepared.checkout) return this.fail('source start has no checkout')
      file = cfg.nodePath || 'node'
      fullArgs = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args]
      cwd = prepared.checkout
    }

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
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
      const child = spawn(file, fullArgs, {
        cwd,
        env,
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
      child.once('close', () => {
        this.child = undefined
        // While starting, waitForReady owns the diagnosis (it checks the pid);
        // while stopping, stopInternal owns the transition.
        if (this.state === 'running') this.setState('stopped')
      })
    } catch (error) {
      return this.fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try { fs.closeSync(logFd) } catch { /* child owns the duplicate */ }
    }
    this.startLogPump()
    return true
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
        this.setState('running')
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
    this.setState('starting')
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
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined
      this.installing = false
    })
    return this.startPromise
  }

  private killTracked(): void {
    const child = this.child
    const pid = this.pid
    this.child = undefined
    this.pid = undefined
    if (child?.pid) killPid(child.pid, this.host.dbg)
    if (pid !== undefined) killPid(pid, this.host.dbg)
  }

  private async stopInternal(killUntracked: boolean): Promise<boolean> {
    if (this.state === 'stopped') {
      if (await isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS)) {
        // An adopted/foreign server is still listening.
      } else {
        return false
      }
    }
    this.setState('stopping')
    this.killTracked()
    this.stopLogPump()
    if (killUntracked) {
      const owner = await findPortOwner(this.instance.port)
      if (owner !== undefined && owner !== process.pid) killPid(owner, this.host.dbg)
    }
    for (let i = 0; i < STOP_POLL_ATTEMPTS; i++) {
      await sleep(STOP_POLL_INTERVAL_MS)
      if (!(await isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS))) {
        this.url = ''
        this.error = ''
        this.setState('stopped')
        this.activity('■ Stopped')
        return true
      }
    }
    const stillOpen = await isPortOpen('127.0.0.1', this.instance.port, STOP_POLL_PROBE_MS)
    if (stillOpen) {
      return this.fail(`could not stop: port ${this.instance.port} is still in use`)
    }
    this.url = ''
    this.setState('stopped')
    return true
  }

  /** Stop the instance; repeated calls coalesce. */
  stop(killUntracked = true): Promise<boolean> {
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
    if (open && this.state !== 'running') {
      await this.adopt(this.instance.port)
    } else if (!open && this.state === 'running') {
      this.url = ''
      this.stopLogPump()
      this.setState('stopped')
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
      error: this.error,
      url: display,
      uiUrl: this.url || display,
      logPath: this.logPath,
      logPathShort: maskPath(this.logPath),
    }
  }

  /** The port is open but the runtime has no child (adopted server). */
  isAdopted(): boolean {
    return this.state === 'running' && this.child === undefined
  }
}
