import * as vscode from 'vscode'
import { httpOk, isPortOpen, tokenAccepted } from './server/probes.ts'
import { ensureCheckoutReady, type CheckoutHost } from './server/checkout.ts'
import { stopLogTail as stopTail, type LogTailHost } from './server/log-tail.ts'
import {
  detectDsh as detectDshInner,
  detectDshVersion as detectDshVersionInner,
  type DetectConfig,
  type DetectHost,
  type DshDetection,
} from './server/detect.ts'
import {
  findPortOwner,
  getTrackedPid,
  killPid,
  spawnPkg as spawnPkgInner,
  spawnSource as spawnSourceInner,
  takeTracked,
  type ProcessHost,
} from './server/process.ts'
import {
  checkNodeOnce as checkNodeOnceInner,
  reportSilentExit as reportSilentExitInner,
  NODE_22_MIN_MINOR,
  NODE_MIN_MAJOR,
  type NodeCheckHost,
} from './server/node-check.ts'
import {
  checkDshUpdateStatus,
  isUpdating,
  runDshUpdate as runDshUpdateInner,
  type DshUpdate,
  type UpdateHost,
} from './server/update.ts'
import {
  ensurePnpmAvailable,
  ensureSourceCheckout,
  findSourceCheckout,
  pkgInstallDir,
  preparePkgStart,
  type InstallHost,
} from './server/install.ts'
import {
  extractWebToken,
} from './env.ts'
import {
  DETECTION_CACHE_TTL_MS,
  HTTP_PROBE_TIMEOUT_MS,
  PORT_POLL_INTERVAL_MS,
  STOP_POLL_ATTEMPTS,
  STOP_POLL_INTERVAL_MS,
  STOP_POLL_PROBE_MS,
} from './timing.ts'
import { canTransition, type ServerPhase } from './phases.ts'
import {
  maskPath,
  resolveDshHome,
} from './paths.ts'
import {
  versionFromDescribe,
} from './versions.ts'
import { isProcessAlive, sleep } from './proc.ts'
import {
  activityLogFile,
  addActivity,
  appendOutput,
  displayLine,
  dbg,
  fileSizeSafe,
  finishBusy,
  outputLineCount,
  scanLogForToken,
  serverLogFile,
} from './server/activity.ts'

// Re-export DeepSeek status/balance for the panel (kept in ds.ts so this
// module stays focused on server lifecycle).
export { fetchDshBalance, getDshBalance, getDsStatus, hasDeepSeekModel } from './ds.ts'

/** dsh binds loopback only; the launcher probes and opens this fixed host. */
const LOOPBACK_HOST = '127.0.0.1'

import { migrateLegacyDshConfig, onDshConfigChanged, readConfig, writeRunMode, type DshConfig } from './server/config.ts'

export { migrateLegacyDshConfig, onDshConfigChanged, readConfig, writeRunMode, type DshConfig }

/** The run-mode literal type, owned by the config module. */
export type RunMode = DshConfig['runMode']

/**
 * Persist the run mode chosen in the panel toggle.
 *
 * Both caches are mode-dependent (detection reads the pkg install or the source
 * checkout; the update check reads the registry or the release tag), so they
 * are dropped before the write lands.
 */
export async function applyMode(mode: RunMode): Promise<void> {
  detectionCache = undefined
  updateCache = undefined
  await writeRunMode(mode)
}

/** Invalidate the mode-dependent caches when dsh settings change outside the panel. */
export function registerConfigWatcher(): vscode.Disposable {
  return onDshConfigChanged(() => {
    detectionCache = undefined
    updateCache = undefined
  })
}

type ConditionState = 'unknown' | 'ok' | 'missing'

export interface ServerStatus {
  running: boolean
  starting: boolean
  /** First-run setup (download / clone / build) is in progress. */
  installing: boolean
  /** A Stop is in progress (server is shutting down). */
  stopping: boolean
  /** Whether an update check is in progress (drives the Check updates button). */
  checking: boolean
  /**
   * An update is rewriting the checkout / package tree. Start must stay greyed
   * for the whole run: the entry guard alone cannot cover the minutes a
   * far-behind `git fetch` takes.
   */
  updating: boolean
  url: string
  dsh: ConditionState
  dshVersion: string
  dshPath: string
  dshHome: string
  dshPathShort: string
  dshHomeShort: string
  nodeVersion: string
  mode: 'pnpm' | 'source'
  update: DshUpdate | undefined
  /** Launcher activity log + server stdout/stderr log (full and masked paths). */
  consoleLogPath: string
  consoleLogPathShort: string
  serverLogPath: string
  serverLogPathShort: string
  consoleLogSize: number
  serverLogSize: number
  /** Whether NODE_DEBUG=module is enabled in source mode. */
  sourceDebug: boolean
}

/** The in-flight setup/update terminal task, so Stop can terminate it. */
let activeTerminalTask: vscode.TaskExecution | undefined
let busy: Promise<boolean> | undefined
let startBusyId = 0
let nodeState: ConditionState = 'unknown'
let dshState: ConditionState = 'unknown'
/** The server lifecycle phase; `starting` for the panel derives from it. */
let serverPhase: ServerPhase = 'stopped'
let checkingUpdates = false

/** Current in-flight check state (panel fallback reads it instead of assuming false). */
export function isCheckingUpdates(): boolean {
  return checkingUpdates
}

/**
 * The install layer's view of this module's lifecycle state.
 *
 * The install code owns everything about *getting* dsh; it is handed these
 * accessors instead of importing them, so the dependency runs one way and this
 * module stays the single owner of the server's state.
 */
const installHost: InstallHost = {
  addActivity,
  finishBusy,
  runInTerminal: (title, command, args, env) => runInTerminal(title, command, args, env),
  runInstalling: (task) => runInstalling(task),
  setDshVersion: (version) => { dshVersion = version },
  setDshState: (state) => { dshState = state },
  isStarting: () => serverPhase === 'starting',
  dbg,
}

/** The checkout layer's view of this module's lifecycle state (a subset). */
const checkoutHost: CheckoutHost = {
  addActivity,
  runInTerminal: (title, command, args, env) => runInTerminal(title, command, args, env),
  runInstalling: (task) => runInstalling(task),
  isStarting: () => serverPhase === 'starting',
}

// The server log tailer lives in server/log-tail.ts; it is handed the log path
// and the feed it writes into.
const logTailHost: LogTailHost = { serverLogFile, displayLine, addActivity }

/** The process layer's view of this module's lifecycle state. */
const processHost: ProcessHost = {
  appendOutput,
  addActivity,
  setDshState: (state) => { dshState = state },
  setStartBusyId: (id) => { startBusyId = id },
  clearWebToken: () => { webToken = undefined },
  isStarting: () => serverPhase === 'starting',
  onLaunchFailed: () => {
    setServerPhase('stopped')
    addActivity('✗ Server failed to launch — no process id was reported (see the log above)')
  },
  logTail: logTailHost,
  dbg,
}

/**
 * The detection layer's view of this module.
 *
 * Detection reads settings and the checkout locator; it is handed both so the
 * "where do settings come from" question stays in one place.
 */
const detectHost: DetectHost = {
  findSourceCheckout: (cfg) => findSourceCheckout(cfg),
  setDshVersion: (version) => { dshVersion = version },
}

/**
 * The update layer's view of this module's lifecycle state.
 *
 * An update may only run while the server is stopped, so it is handed that
 * question rather than the phase itself — the rule stays in one place.
 */
const updateHost: UpdateHost = {
  readConfig,
  findSourceCheckout: () => findSourceCheckout(readConfig()),
  addActivity,
  finishBusy,
  runInTerminal: (title, command, args, env) => runInTerminal(title, command, args, env),
  dbg,
  isStopped: () => serverPhase === 'stopped',
  invalidateUpdateCache: () => { updateCache = undefined },
  installHost,
  checkoutHost,
}

/**
 * Transition the server lifecycle phase. Invalid transitions are logged (not
 * rejected) so a stray assignment cannot silently corrupt the lifecycle state.
 */
function setServerPhase(to: ServerPhase): void {
  if (!canTransition(serverPhase, to)) {
    dbg(`unexpected server phase transition ${serverPhase} -> ${to}`)
  }
  serverPhase = to
}

/**
 * Run a first-install setup step (download / clone / build) inside the start
 * flow: the phase temporarily becomes 'installing' so the panel shows the
 * right status. Outside the start flow (e.g. an update) the phase is left
 * untouched, and a Stop that intervenes mid-step is honoured.
 */
async function runInstalling<T>(task: () => Promise<T>): Promise<T> {
  const phase = serverPhase
  if (phase !== 'starting') return task()
  setServerPhase('installing')
  try {
    return await task()
  } finally {
    if (serverPhase === 'installing') setServerPhase('starting')
  }
}
let dshVersion = ''
let dshPath = ''
let nodeVersion = ''

/** The subset of settings the detection layer needs. */
function detectConfig(cfg: DshConfig): DetectConfig {
  return { runMode: cfg.runMode, srcPath: cfg.srcPath, pkgPath: cfg.pkgPath }
}


/** The web access token of the current run (dsh ≥ 0.1.2-alpha.1 prints one). */
let webToken: string | undefined

export function uiUrl(cfg: DshConfig = readConfig()): string {
  const token = webToken ? `/?token=${webToken}` : ''
  return `http://${LOOPBACK_HOST}:${cfg.port}${token}`
}

/** The URL shown in the panel/status line — never carries the auth token (uiUrl is for opening the browser). */
function displayUrl(cfg: DshConfig = readConfig()): string {
  return `http://${LOOPBACK_HOST}:${cfg.port}`
}

/**
 * The token dsh ≥ 0.1.2-alpha.1 prints on startup (e.g.
 * `dsh web: http://127.0.0.1:3080/?token=…`): the web UI answers 401 without
 * it. Read it from the server log — the single output sink on every platform —
 * and cache it for the run.
 */
function readServerToken(): string | undefined {
  if (webToken) return webToken
  const token = scanLogForToken(extractWebToken)
  if (token) webToken = token
  return token
}

// The activity feed and the two log files live in server/activity.ts; the panel
// and the extension read them through this module's re-exports.
export { clearConsole, getActivity, setLogPath, dbg, addActivity, finishBusy, type ActivityEntry } from './server/activity.ts'

/**
 * The URL that actually serves the web UI, or undefined while it is not ready
 * yet. Version-agnostic by probing instead of assuming: older dsh versions
 * (pkg or source) serve the plain URL directly, so it is tried first; dsh ≥
 * 0.1.2-alpha.1 answers token-less requests with 401 and needs the token URL
 * it prints on startup. A cached token that no longer works is dropped, so
 * the next poll rescans the log instead of being stuck on a dead token.
 */
async function resolveWebUrl(host: string, port: number, timeoutMs: number, token: string | undefined): Promise<string | undefined> {
  const plain = `http://${host}:${port}/`
  if (await httpOk(plain, timeoutMs)) {
    // The plain URL serves: whatever token was cached belongs to another run
    // (or the version never prints one), so the browser gets the plain URL.
    webToken = undefined
    return plain
  }
  if (token) {
    const tokenUrl = `http://${host}:${port}/?token=${token}`
    if (await tokenAccepted(tokenUrl, timeoutMs)) return tokenUrl
    // Stale or not yet accepted: drop the cache so the next poll rescans.
    webToken = undefined
  }
  return undefined
}

// The Node version check and the silent-exit diagnosis live in
// server/node-check.ts; they read this module's detected values through host.
const nodeCheckHost: NodeCheckHost = {
  nodePath: () => readConfig().nodePath,
  addActivity,
  setNodeState: (state) => { nodeState = state },
  setNodeVersion: (version) => { nodeVersion = version },
  nodeVersion: () => nodeVersion,
  outputLineCount,
}

/**
 * Check Node once (memoized) and cache the result. Called at activation so
 * Start and the status refresh never re-probe Node. The check itself lives in
 * server/node-check.ts.
 */
export function checkNodeOnce(): Promise<void> {
  return checkNodeOnceInner(nodeCheckHost)
}




/**
 * Run a command in a visible VS Code terminal (used for setup and updates).
 * Arguments are passed as an array so VS Code quotes them for the active
 * shell — paths never go through manual string interpolation, which breaks on
 * `$`/backticks/parentheses in PowerShell and `%`/`&` in cmd. `env`
 * entries are merged into the terminal process environment, which is how the
 * source-mode build requests dsh's official client profile. The in-flight
 * execution is tracked so Stop can terminate it mid-setup.
 */
async function runInTerminal(title: string, command: string, args: string[], env?: Record<string, string>): Promise<boolean> {
  const task = new vscode.Task(
    { type: 'dsh-shell' },
    vscode.TaskScope.Global,
    title,
    'DeepSeek Harness',
    new vscode.ShellExecution(command, args, env ? { env } : undefined),
  )
  return new Promise<boolean>((resolve) => {
    let execution: vscode.TaskExecution | undefined
    // Attach the end listener BEFORE executing: a task that finished before
    // the listener would never resolve this promise, leaving the start flow
    // (and the busy coalescing lock) hanging forever.
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (execution !== undefined && event.execution === execution) {
        disposable.dispose()
        if (activeTerminalTask === execution) activeTerminalTask = undefined
        resolve(event.exitCode === 0)
      }
    })
    void vscode.tasks.executeTask(task).then((ex) => {
      execution = ex
      activeTerminalTask = ex
    }, () => {
      disposable.dispose()
      addActivity(`✗ could not run "${title}" in a terminal`)
      resolve(false)
    })
  })
}

export function stopLogTail(): void {
  stopTail(logTailHost)
}


/** Poll the port until it opens, the spawned process dies, or the user stops. */
async function waitForPort(cfg: DshConfig, version: string): Promise<boolean> {
  const startedAt = Date.now()
  // No hard timeout: the first start of a new dsh version installs many
  // packages and can take several minutes. The fail-fast below still reports
  // a dead spawn, and Stop stays available from the panel.
  while (true) {
    await sleep(PORT_POLL_INTERVAL_MS)
    // The user pressed Stop while starting: bail out quietly (Stop already
    // reported its own outcome). Stop's kill request returns immediately, so
    // by the time this wakes the phase is often already back at 'stopped' —
    // checking only 'stopping' would miss it and spin forever (or report a
    // running server nobody wants). Any phase other than 'starting' means the
    // start was interrupted.
    if (serverPhase !== 'starting') {
      finishBusy(startBusyId)
      return false
    }
    // The port binds before the web app finishes booting; wait for an HTTP
    // response so the browser doesn't open onto a blank page. resolveWebUrl
    // handles both dsh ≥ 0.1.2-alpha.1 (token URL) and older versions (plain
    // URL) by probing whichever actually answers 2xx.
    if ((await resolveWebUrl(LOOPBACK_HOST, cfg.port, HTTP_PROBE_TIMEOUT_MS, readServerToken())) !== undefined) {
      // Stop can complete while the HTTP probe is in flight (it takes up to
      // HTTP_PROBE_TIMEOUT_MS): re-check the phase before flipping a stopped
      // server back to 'running'.
      if (serverPhase !== 'starting') {
        finishBusy(startBusyId)
        return false
      }
      setServerPhase('running')
      const secs = Math.round((Date.now() - startedAt) / 1000)
      const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`
      addActivity(`✓ Server started ${displayUrl(cfg)} in ${dur}`)
      finishBusy(startBusyId)
      return true
    }
    // Fail fast when the spawned process already exited (e.g. port already in use).
    const pid = getTrackedPid()
    if (pid !== undefined && !isProcessAlive(pid)) {
      setServerPhase('stopped')
      addActivity('✗ Server exited before opening the port (see the log above)')
      finishBusy(startBusyId)
      // The diagnosis runs a Node capability probe; the spinner is already off.
      await reportSilentExitInner(nodeCheckHost, version)
      return false
    }
  }
}

/**
 * Coalesce concurrent start calls onto one in-flight run. (Stop deliberately
 * bypasses this so it can interrupt a start; see stopServer.)
 */
function exclusive(task: () => Promise<boolean>): Promise<boolean> {
  if (busy) return busy
  busy = task().finally(() => {
    busy = undefined
    // A start that finished without reaching 'running' (or being stopped)
    // lands back at 'stopped'.
    if (serverPhase === 'starting' || serverPhase === 'installing') setServerPhase('stopped')
  })
  return busy
}

/** Whether a checkout has its dependencies installed (`tsx` is the source-launch hook). */

/** Make sure the server is running (no re-entrancy guard). */
async function ensureRunningUnlocked(cfg: DshConfig): Promise<boolean> {
  await detectDshVersionInner(detectConfig(cfg), detectHost)
  if (await isPortOpen(LOOPBACK_HOST, cfg.port)) {
    nodeState = 'ok'
    dshState = 'ok'
    // A server that outlived this extension host (e.g. after a VS Code reload)
    // still needs the right URL: probe the running server so the browser
    // opens the token URL for dsh ≥ 0.1.2-alpha.1 and the plain URL for
    // versions that do not use one.
    await resolveWebUrl(LOOPBACK_HOST, cfg.port, HTTP_PROBE_TIMEOUT_MS, readServerToken())
    addActivity(`✓ Server already running ${displayUrl(cfg)}`)
    return true
  }

  // A stop is still finishing: don't race it with a new start.
  const phase = serverPhase
  if (phase === 'stopping') {
    addActivity('⚠ Stop is still in progress — wait a moment and try again')
    return false
  }

  // An update is rewriting the checkout / package tree underneath us. Starting
  // now would run dsh from a tree that is about to be swapped — the collision
  // the update's own entry guard cannot cover, because its `git fetch` can take
  // minutes. The panel greys Start for the same reason; this guard also covers
  // the command palette and the status-bar menu.
  if (isUpdating()) {
    addActivity('⚠ Update is in progress — wait for it to finish before starting')
    return false
  }

  // Enter the 'starting' phase from the very first await, so status refreshes
  // keep the Start button grey instead of un-greying it mid-setup.
  setServerPhase('starting')

  await checkNodeOnce()
  if (nodeState === 'missing') {
    addActivity(`✗ Node.js not found (need 22.x >= 22.${NODE_22_MIN_MINOR} or >= ${NODE_MIN_MAJOR})`)
    return false
  }

  if (cfg.runMode === 'source') {
    const checkout = await ensureSourceCheckout(cfg, installHost)
    if (!checkout) return false
    if (!(await ensureCheckoutReady(checkout.path, checkoutHost, checkout.cloned))) {
      dshState = 'missing'
      return false
    }
    // Setup may have run while the user pressed Stop; honour that request
    // instead of starting a server nobody is waiting for.
    if (serverPhase !== 'starting') return false
    // dshVersion 在 source 模式是规整过的 git describe 输出（如 v0.1.2-rc.1-99-g76fda72），
    // buildWebArgs 需要干净的语义化版本号来比较 --no-open。
    const runVersion = versionFromDescribe(dshVersion) ?? dshVersion
    spawnSourceInner(checkout.path, cfg, runVersion, processHost)
    return waitForPort(cfg, runVersion)
  }

  // pkg mode: install dsh into the managed pnpm project, then run it (source needs explicit opt-in)
  const pnpmCmd = await ensurePnpmAvailable(installHost)
  if (!pnpmCmd) return false
  const version = await preparePkgStart(cfg, pnpmCmd.command, pnpmCmd.allowBuild, installHost)
  if (!version) return false
  // The install may have run while the user pressed Stop; honour that request
  // instead of starting a server nobody is waiting for.
  if (serverPhase !== 'starting') return false
  spawnPkgInner(cfg, pnpmCmd.command, version, pkgInstallDir(cfg), processHost)
  return waitForPort(cfg, version)
}

/**
 * Make sure the server is running. Resolution: a source checkout (git clone)
 * or a managed pnpm install of the published dsh (`pnpm exec dsh web`).
 * Concurrent calls coalesce onto the in-flight run.
 */
export function ensureRunning(cfg: DshConfig = readConfig()): Promise<boolean> {
  return exclusive(() => ensureRunningUnlocked(cfg))
}


/** Stop the server, killing the tracked child and/or whatever owns the port (no guard). */
async function stopServerUnlocked(wasStarting: boolean): Promise<boolean> {
  const cfg = readConfig()
  const pids: number[] = []
  // Take both handles in one pass: the process registry lives in
  // server/process.ts, and clearing it here means a second stop cannot kill a
  // pid this one already reaped.
  const tracked = takeTracked()
  if (tracked.pid) {
    pids.push(tracked.pid)
    killPid(tracked.pid, dbg)
  }
  if (tracked.child?.pid) {
    pids.push(tracked.child.pid)
    killPid(tracked.child.pid, dbg)
  }
  // A setup/update running in a terminal is not killed by the server tree:
  // terminate it so the start flow can settle instead of holding the busy
  // promise until the command finishes on its own.
  void activeTerminalTask?.terminate()
  const owner = await findPortOwner(cfg.port)
  // Only fall back to the port owner when no tracked process was recorded:
  // with a tracked tree, taskkill /T already covers the descendants, and
  // killing whatever owns the port could take down an unrelated app.
  if (pids.length === 0 && owner !== undefined && owner !== process.pid) {
    pids.push(owner)
    killPid(owner, dbg)
  }
  // Keep the phase at 'stopping' through the kill + port polling below:
  // moving to 'stopped' early made the panel show Running/New Tab and accept
  // a Start while the kill was still in flight.
  webToken = undefined
  stopLogTail()
  if (pids.length === 0) {
    setServerPhase('stopped')
    addActivity(wasStarting ? '■ Setup interrupted — no server will be started' : '■ Server not running')
    return false
  }
  addActivity('■ Stopping server…')
  for (let i = 0; i < STOP_POLL_ATTEMPTS; i++) {
    await sleep(STOP_POLL_INTERVAL_MS)
    if (!(await isPortOpen(LOOPBACK_HOST, cfg.port, STOP_POLL_PROBE_MS))) {
      setServerPhase('stopped')
      addActivity('■ Server stopped')
      return true
    }
  }
  const stillOpen = await isPortOpen(LOOPBACK_HOST, cfg.port, STOP_POLL_PROBE_MS)
  setServerPhase('stopped')
  addActivity(stillOpen ? '⚠ Could not stop the server — the port is still in use' : '■ Server stopped')
  return !stillOpen
}

let stopInFlight: Promise<boolean> | undefined

export function stopServer(): Promise<boolean> {
  // Stop must be able to interrupt an in-flight start, so it does not go
  // through exclusive() (which would return the pending start promise and
  // skip stopping). The phase makes the concurrent waitForPort bail out.
  // Rapid repeat clicks coalesce onto the one in-flight stop.
  if (stopInFlight) return stopInFlight
  // Capture the pre-stop phase here: stopServerUnlocked runs after the phase
  // has already been moved to 'stopping', so it can't tell a Setup interrupt
  // from a plain stop anymore.
  const wasStarting = serverPhase === 'installing' || serverPhase === 'starting'
  if (wasStarting || serverPhase === 'running') setServerPhase('stopping')
  stopInFlight = stopServerUnlocked(wasStarting).finally(() => {
    stopInFlight = undefined
  })
  return stopInFlight
}

// The update check and the update itself live in server/update.ts; this module
// supplies the lifecycle state they must respect.
export { isUpdating, type DshUpdate } from './server/update.ts'

let detectionCache: { dsh: DshDetection; at: number } | undefined
let updateCache: { update: DshUpdate; at: number } | undefined

export async function currentStatus(): Promise<ServerStatus> {
  const cfg = readConfig()
  let running = false
  try {
    running = await isPortOpen(LOOPBACK_HOST, cfg.port)
  } catch {
    running = false
  }

  // Periodically probe node/dsh so the panel reflects reality without a start.
  const now = Date.now()
  if (!detectionCache || now - detectionCache.at > DETECTION_CACHE_TTL_MS) {
    const dshDet = await detectDshInner(detectConfig(cfg), detectHost)
    dshState = dshDet.state
    dshPath = dshDet.path
    detectionCache = { dsh: dshDet, at: now }
    // Installing/starting is mid-flight: the package tree may not be ready yet,
    // and a re-detect here clobbers dshVersion (the panel version row flashes
    // a placeholder during first-run installs).
    if (serverPhase !== 'starting' && serverPhase !== 'installing') await detectDshVersionInner(detectConfig(cfg), detectHost)
  }

  if (running) {
    nodeState = 'ok'
    dshState = 'ok'
  }

  const dshHome = resolveDshHome()
  return {
    running,
    starting: serverPhase === 'starting',
    installing: serverPhase === 'installing',
    stopping: serverPhase === 'stopping',
    checking: checkingUpdates,
    updating: isUpdating(),
    url: displayUrl(cfg),
    dsh: dshState,
    dshVersion,
    dshPath,
    dshHome,
    dshPathShort: maskPath(dshPath),
    dshHomeShort: maskPath(dshHome),
    nodeVersion,
    mode: cfg.runMode === 'source' ? 'source' : 'pnpm',
    update: updateCache?.update,
    consoleLogPath: activityLogFile(),
    consoleLogPathShort: maskPath(activityLogFile()),
    serverLogPath: serverLogFile(),
    serverLogPathShort: maskPath(serverLogFile()),
    consoleLogSize: fileSizeSafe(activityLogFile()),
    serverLogSize: fileSizeSafe(serverLogFile()),
    sourceDebug: cfg.sourceDebug,
  }
}

/** Force the next refresh to re-probe node/dsh and re-check for dsh updates. */
export async function clearRequirementsCaches(): Promise<void> {
  detectionCache = undefined
  updateCache = undefined
  checkingUpdates = true
  try {
    const update = await checkDshUpdateStatus(updateHost)
    updateCache = { update, at: Date.now() }
  } finally {
    checkingUpdates = false
  }
}

/** Mark the update check in-flight before the first refresh, so the button stays grey. */
export function setCheckingUpdates(value: boolean): void {
  checkingUpdates = value
}

/**
 * Update dsh to the newest version this mode tracks.
 *
 * A thin wrapper: the flow itself lives in server/update.ts, which owns the
 * in-flight guard and the rule that an update may only run while stopped.
 */
export function runDshUpdate(): Promise<void> {
  return runDshUpdateInner(updateHost)
}

