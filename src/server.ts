import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as vscode from 'vscode'
import {
  ACTIVITY_MAX_LINES,
  DEFAULT_PORT,
  DETECTION_CACHE_TTL_MS,
  DSH_INSTALL_MANIFEST_NAME,
  DSH_BUILD_PROFILE_OFFICIAL,
  DSH_BUILD_PROFILE_SELECTOR,
  DSH_NO_OPEN_MIN_VERSION,
  GIT_OP_TIMEOUT_MS,
  HTTP_PROBE_TIMEOUT_MS,
  LOG_RELOAD_LINES,
  LOG_TAIL_POLL_MS,
  MAX_PORT,
  MODULE_PROGRESS_EVERY,
  NODE_PROBE_TIMEOUT_MS,
  PNPM_PROBE_TIMEOUT_MS,
  PNPM_VIEW_TIMEOUT_MS,
  TASKKILL_TIMEOUT_MS,
  PORT_PROBE_TIMEOUT_MS,
  PORT_POLL_INTERVAL_MS,
  STOP_POLL_ATTEMPTS,
  STOP_POLL_INTERVAL_MS,
  STOP_POLL_PROBE_MS,
  canTransition,
  checkoutHasOfficialBrand,
  checkoutSupportsClean,
  checkoutSupportsOfficialBuild,
  dshBaseDir,
  dshVersionAtLeast,
  extractWebToken,
  findPnpm,
  installedDshVersion,
  isDshCheckout,
  isDshInstallDirUsable,
  isProcessAlive,
  maskPath,
  pnpmSupportsDangerouslyAllowAllBuilds,
  psQuote,
  quoteCmdArg,
  resolveDshHome,
  runFile,
  sleep,
  type ServerPhase,
} from './common'

// Re-export DeepSeek status/balance for the panel (kept in ds.ts so this
// module stays focused on server lifecycle).
export { fetchDshBalance, getDshBalance, getDsStatus, hasDeepSeekModel } from './ds'

type DshMode = 'pnpm' | 'source'

/** dsh binds loopback only; the launcher probes and opens this fixed host. */
const LOOPBACK_HOST = '127.0.0.1'

type DshChannel = 'latest' | 'next'

/** Resolved extension settings (dsh.*). */
export interface DshConfig {
  mode: DshMode
  /** Which npm dist-tag pnpm resolves: 'latest' (default) or 'next' (prereleases). */
  channel: DshChannel
  path: string
  /** Custom pkg install dir (defaults to the managed dir when empty). */
  pkgPath: string
  nodePath: string
  port: number
  /** Print module-loading progress in source mode (NODE_DEBUG=module). */
  sourceDebug: boolean
  /** Open the browser automatically after Start (dsh.autoOpenBrowser; explicit 'New Tab' clicks always open). */
  autoOpenBrowser: boolean
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

export interface DshUpdate {
  hasUpdate: boolean
  label: string
  /** True when the check could not run (network etc.) — not "no update". */
  failed?: boolean
}

let trackedChild: ChildProcess | undefined
let trackedPid: number | undefined
/** The in-flight setup/update terminal task, so Stop can terminate it. */
let activeTerminalTask: vscode.TaskExecution | undefined
let logPath = ''
let consolePath = ''
let busy: Promise<boolean> | undefined
/** One line in the panel activity feed; `busy` marks an in-progress operation. */
interface ActivityEntry {
  id: number
  text: string
  busy: boolean
}

const activity: ActivityEntry[] = []
let activitySeq = 0
let startBusyId: number | undefined
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
let logTailWatcher: fs.FSWatcher | undefined
let logTailTimer: ReturnType<typeof setInterval> | undefined
let logTailOffset = 0
let logTailBuffer = ''
let moduleLoadCount = 0
let dshVersion = ''
let dshPath = ''
let nodeVersion = ''

export function readConfig(): DshConfig {
  // Read the persisted settings every time: dsh.mode is the single source
  // of truth, so both the panel toggle and the Settings UI stay in sync.
  const c = vscode.workspace.getConfiguration('dsh')
  // Clamp the port to the valid TCP range; an out-of-range value from Settings
  // Sync or manual edits would otherwise make every probe throw.
  const port = c.get<number>('port') ?? DEFAULT_PORT
  return {
    mode: c.get<string>('mode') === 'source' ? 'source' : 'pnpm',
    channel: c.get<string>('channel') === 'next' ? 'next' : 'latest',
    path: c.get<string>('path') ?? '',
    pkgPath: c.get<string>('pkgPath') ?? '',
    nodePath: c.get<string>('nodePath') ?? '',
    port: Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : DEFAULT_PORT,
    sourceDebug: c.get<boolean>('sourceDebug') ?? false,
    autoOpenBrowser: c.get<boolean>('autoOpenBrowser') ?? true,
  }
}

/** Persist the run mode chosen in the panel toggle and apply it immediately. */
export async function applyMode(mode: 'pnpm' | 'source'): Promise<void> {
  // Both caches are mode-dependent: detection (pkg install vs source checkout)
  // and the update check (registry vs git upstream).
  detectionCache = undefined
  updateCache = undefined
  await vscode.workspace.getConfiguration('dsh').update('mode', mode, vscode.ConfigurationTarget.Global)
}

/** Invalidate caches when dsh settings change outside the panel (Settings UI, sync, …). */
export function registerConfigWatcher(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dsh')) {
      detectionCache = undefined
      updateCache = undefined
    }
  })
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
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/)
    // Newest line first: with dsh.clearServerLogOnStart off, the log may hold
    // several runs, and the current run's token is the most recent one.
    for (let i = lines.length - 1; i >= 0; i--) {
      const token = extractWebToken(lines[i])
      if (token) {
        webToken = token
        return token
      }
    }
  } catch {
    // log not written yet
  }
  return undefined
}

export function setLogPath(value: string): void {
  // Both logs live in one folder (client.log = launcher activity, server.log
  // = server output). The server redirects to the latter (holding it open),
  // so keeping them distinct avoids the launcher's writes being lost to locks.
  consolePath = value
  logPath = path.join(path.dirname(value), 'server.log')
  try {
    if (fs.existsSync(consolePath)) {
      const lines = fs.readFileSync(consolePath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
      for (const line of lines.slice(-LOG_RELOAD_LINES)) {
        if (line.includes('[dbg]')) continue
        pushActivity(line)
      }
    }
  } catch {
    // best effort
  }
}

/** Append one entry to the console log file (best effort). */
function appendLog(entry: string): void {
  if (!consolePath) return
  try {
    fs.mkdirSync(path.dirname(consolePath), { recursive: true })
    fs.appendFileSync(consolePath, entry + '\n')
  } catch {
    // best effort
  }
}

/** Append a diagnostic line to the log file only (kept out of the console feed). */
export function dbg(line: string): void {
  appendLog(`[${new Date().toLocaleTimeString()}] [dbg] ${line}`)
}

function pushActivity(entry: string, isBusy = false): number {
  const id = ++activitySeq
  activity.push({ id, text: entry, busy: isBusy })
  if (activity.length > ACTIVITY_MAX_LINES) activity.splice(0, activity.length - ACTIVITY_MAX_LINES)
  return id
}

/** Append one line to the panel activity feed + the log file. */
export function addActivity(line: string, isBusy = false): number {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`
  const id = pushActivity(entry, isBusy)
  appendLog(entry)
  return id
}

/** Append one server-output line to the activity feed only (already in the log file). */
function displayLine(line: string): void {
  const trimmed = line.trimEnd()
  if (!trimmed) return
  // NODE_DEBUG=module is extremely verbose; keep individual lines out of the
  // console feed (they stay in the server log file), but surface a periodic
  // count so a slow source startup still shows progress.
  if (/^MODULE\s/.test(trimmed)) {
    moduleLoadCount++
    if (moduleLoadCount % MODULE_PROGRESS_EVERY === 0) {
      pushActivity(`[${new Date().toLocaleTimeString()}] ℹ Loading modules… (${moduleLoadCount})`)
    }
    return
  }
  pushActivity(`[${new Date().toLocaleTimeString()}] ${trimmed}`)
}

/** Append one raw server output line to the activity feed + log file. */
function appendOutput(line: string): void {
  displayLine(line)
  const trimmed = line.trimEnd()
  if (!trimmed) return
  fs.appendFile(logPath, trimmed + '\n', (error) => {
    if (error) dbg(`server log append failed: ${error.message}`)
  })
}

/** The panel activity feed (Start/Stop command dynamics), newest last. */
export function getActivity(): ActivityEntry[] {
  return activity
}

/** Finish one busy entry by its addActivity id (concurrent busy operations each
 * clear only their own spinner); without an id, clear the most recent busy entry. */
export function finishBusy(id?: number): void {
  if (id !== undefined) {
    const entry = activity.find((e) => e.id === id)
    if (entry !== undefined) entry.busy = false
    return
  }
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].busy) {
      activity[i].busy = false
      return
    }
  }
}

/** Size of a file in bytes, 0 when absent or unreadable. */
function fileSizeSafe(p: string): number {
  if (!p) return 0
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

/** Non-destructive port probe; resolves without throwing. */
function isPortOpen(host: string, port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: net.Socket
    try {
      socket = new net.Socket()
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // already closed
      }
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

/** Whether a GET against `url` answers 2xx (resolves without throwing). */
async function httpOk(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a token URL proves the server is up. dsh ≥ 0.1.2-alpha.1 answers a
 * valid launch token with a 303 cookie-minting redirect; following it without
 * a cookie jar lands back on a 401 (undici's fetch keeps no cookies), so the
 * probe stops at the redirect — the browser performs the cookie dance itself
 * when the tab opens the token URL.
 */
async function tokenAccepted(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return res.status === 303 || res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

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

/** Node.js engines range the harness requires: ^22.19 || >=24. */
const NODE_MIN_MAJOR = 24
const NODE_22_MIN_MINOR = 19

/** Whether Node.js is present and satisfies the harness engines range. */
async function checkNode(cfg: DshConfig): Promise<{ ok: boolean; version: string }> {
  const result = await runFile(cfg.nodePath || 'node', ['--version'], NODE_PROBE_TIMEOUT_MS)
  const version = result.ok ? result.stdout.trim().replace(/^v/, '') : ''
  if (!result.ok) return { ok: false, version: '' }
  const match = /^v?(\d+)\.(\d+)/.exec(result.stdout.trim())
  if (!match) return { ok: false, version }
  const major = Number(match[1])
  const minor = Number(match[2])
  return { ok: major >= NODE_MIN_MAJOR || (major === 22 && minor >= NODE_22_MIN_MINOR), version }
}

/** Memoized one-shot Node check, run once at extension activation. */
let nodeChecked: Promise<void> | undefined

/**
 * Check Node once (memoized) and cache the result. Called at activation so
 * Start and the status refresh never re-probe Node.
 */
export function checkNodeOnce(): Promise<void> {
  if (!nodeChecked) {
    nodeChecked = (async () => {
      const r = await checkNode(readConfig())
      nodeState = r.ok ? 'ok' : 'missing'
      nodeVersion = r.version
      if (!r.ok) {
        addActivity(`✗ Node.js not found (need 22.x >= 22.${NODE_22_MIN_MINOR} or >= ${NODE_MIN_MAJOR})`)
        void vscode.window.showErrorMessage(`DeepSeek Harness requires Node.js 22.x (22.${NODE_22_MIN_MINOR} or later) or >= ${NODE_MIN_MAJOR}. Install it from https://nodejs.org and restart VS Code.`)
      }
    })()
  }
  return nodeChecked
}

/**
 * The launcher's default dsh package dir for pkg mode — named `package` to
 * mirror the `source` checkout dir: the published package vs the source.
 */
function managedPackageDir(): string {
  return path.join(dshBaseDir(), 'package')
}

/** The launcher's managed source checkout dir (where dsh is cloned for source mode). */
function managedSourceCheckout(): string {
  return path.join(dshBaseDir(), 'source')
}

/** The pkg package dir: the user's dsh.pkgPath when set, else the managed default. */
function pkgInstallDir(cfg: DshConfig): string {
  return cfg.pkgPath && cfg.pkgPath.trim() !== '' ? cfg.pkgPath : managedPackageDir()
}

/** The installed @deepseek-ai/dsh version for the current pkg install dir. */
function pkgInstalledVersion(cfg: DshConfig): string | undefined {
  return installedDshVersion(pkgInstallDir(cfg))
}

/** Ask where to install dsh when nothing is installed yet: default or a custom folder. */
async function chooseInstallDir(kind: 'pkg' | 'source', defaultDir: string): Promise<string | undefined> {
  const pick = await vscode.window.showInformationMessage(
    `Install dsh (${kind}) to the default location?`,
    'Use default location',
    'Choose folder…',
  )
  if (pick === 'Use default location') return defaultDir
  if (pick === 'Choose folder…') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select install folder',
      title: `Choose where to install dsh (${kind})`,
    })
    return picked?.[0]?.fsPath
  }
  return undefined
}

/** Persist a dsh path setting (idempotent). */
async function saveDshSetting(key: 'path' | 'pkgPath', value: string): Promise<void> {
  const c = vscode.workspace.getConfiguration('dsh')
  if ((c.get<string>(key) ?? '') !== value) {
    await c.update(key, value, vscode.ConfigurationTarget.Global)
  }
}

/** Resolve the published @deepseek-ai/dsh version for a channel (undefined on failure). */
async function latestDshVersion(channel: DshChannel, pnpmCmd = 'pnpm'): Promise<string | undefined> {
  const spec = channel === 'next' ? '@deepseek-ai/dsh@next' : '@deepseek-ai/dsh'
  const result = process.platform === 'win32'
    ? await runFile('cmd', ['/c', quoteCmdArg(pnpmCmd), 'view', spec, 'version'], PNPM_VIEW_TIMEOUT_MS)
    : await runFile(pnpmCmd, ['view', spec, 'version'], PNPM_VIEW_TIMEOUT_MS)
  if (!result.ok) {
    // Keep the failure visible for diagnosis: registry outages and cmd
    // quoting problems both surface here as "unreachable" to the user.
    const last = result.stderr.trim().split(/\r?\n/).pop()?.trim()
    if (last) dbg(`pnpm view failed: ${last}`)
    return undefined
  }
  return result.stdout.trim().split(/\r?\n/).pop()?.trim() || undefined
}

/**
 * Prepare the pkg start: resolve the dsh version for the channel, install it
 * into the managed dir when missing or outdated, and report progress. Offline,
 * the installed version is used instead. Returns the version to run, or
 * undefined to abort the start.
 */
async function preparePkgStart(cfg: DshConfig, pnpmCmd: string, allowBuild: boolean): Promise<string | undefined> {
  // The registry query can take a few seconds; show it so a slow network
  // does not look like a frozen Start.
  const resolvingId = addActivity('ℹ Resolving the dsh channel version…', true)
  let version = await latestDshVersion(cfg.channel, pnpmCmd)
  finishBusy(resolvingId)
  if (!version) version = pkgInstalledVersion(cfg)
  if (!version) {
    dshState = 'missing'
    addActivity('✗ dsh is not installed and the registry is unreachable — check your network and try again')
    void vscode.window.showErrorMessage('DeepSeek Harness: unable to reach the registry to install dsh. Check your network connection.')
    return undefined
  }
  // Resolve the install dir: a custom dsh.pkgPath wins; on a first install with
  // no custom path, let the user choose the default or a custom folder.
  let dir = pkgInstallDir(cfg)
  if (installedDshVersion(dir) === undefined && !cfg.pkgPath) {
    const chosen = await chooseInstallDir('pkg', managedPackageDir())
    if (!chosen) return undefined
    // Persist the user's choice even when it is the managed default: the
    // setting then shows the actual install path and pins it against future
    // default-location changes.
    await saveDshSetting('pkgPath', chosen)
    dir = chosen
  }
  const installed = installedDshVersion(dir)
  if (installed === undefined) {
    addActivity(`ℹ dsh v${version} — installing it now (first run, can take a few minutes)`)
  } else if (installed !== version) {
    addActivity(`ℹ dsh v${version} will run (installed: v${installed}) — updating first`)
  }
  // The panel shows the version that is about to run (buildWebArgs also reads
  // this to decide --no-open).
  dshVersion = version
  if (installed !== version && !(await ensureDshInstalled(version, pnpmCmd, allowBuild, dir))) return undefined
  return version
}

/**
 * Install @deepseek-ai/dsh@<version> into the managed dir: write the pinned
 * manifest and run `pnpm install`, approving build scripts non-interactively
 * on pnpm ≥ 10.16 (the same thing npm does on every install). Returns true
 * once the requested version is present.
 */
async function ensureDshInstalled(version: string, pnpmCmd: string, allowBuild: boolean, dir: string): Promise<boolean> {
  // Refuse to install into a folder that holds other files: writing the
  // pinned manifest there would destroy the user's package.json.
  if (!isDshInstallDirUsable(dir)) {
    addActivity(`✗ ${maskPath(dir)} is not empty — install into an empty or dedicated folder instead`)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${maskPath(dir)} is not empty. Choose an empty or dedicated folder for the dsh install.`)
    return false
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: DSH_INSTALL_MANIFEST_NAME,
      private: true,
      dependencies: { '@deepseek-ai/dsh': version },
    }, null, 2) + '\n')
  } catch {
    addActivity('✗ could not write the dsh install manifest — check write permissions')
    return false
  }
  // The phase is already 'starting' (set at the top of ensureRunningUnlocked).
  addActivity(`▶ Installing dsh v${version} (pnpm install)…`)
  const args = ['install', '--dir', dir]
  if (allowBuild) args.push('--dangerously-allow-all-builds')
  const ok = await runInstalling(() => runInTerminal(`Install dsh v${version}`, pnpmCmd, args))
  if (!ok || installedDshVersion(dir) !== version) {
    if (serverPhase === 'starting') {
      addActivity('✗ dsh install failed — see the terminal output above')
      void vscode.window.showErrorMessage('DeepSeek Harness: dsh install failed. Check the terminal output.')
    }
    return false
  }
  return true
}
/** The pnpm version string ('' on failure). */
async function pnpmVersion(pnpmCmd: string): Promise<string> {
  const result = process.platform === 'win32'
    ? await runFile('cmd', ['/c', quoteCmdArg(pnpmCmd), '--version'], PNPM_PROBE_TIMEOUT_MS)
    : await runFile(pnpmCmd, ['--version'], PNPM_PROBE_TIMEOUT_MS)
  return result.ok ? result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '' : ''
}

/**
 * Make sure pnpm is available in pnpm mode: resolve it on PATH (or the known
 * Windows shim locations), and install it via npm when missing. There is no
 * prompt — without pnpm the start cannot proceed, so the console announces
 * the reason and the install begins immediately.
 * Returns the resolved command and whether install accepts
 * --dangerously-allow-all-builds (build-script approval, which would
 * otherwise prompt interactively), or undefined when the start must abort.
 */
async function ensurePnpmAvailable(): Promise<{ command: string; allowBuild: boolean } | undefined> {
  const found = await findPnpm()
  if (found) return { command: found, allowBuild: pnpmSupportsDangerouslyAllowAllBuilds(await pnpmVersion(found)) }
  dshState = 'missing'
  addActivity('✗ pnpm not found — installing it now (npm install -g pnpm)')
  // The phase is already 'starting' (set at the top of ensureRunningUnlocked).
  addActivity('▶ Installing pnpm (npm install -g pnpm)…')
  const ok = await runInstalling(() => runInTerminal('Install pnpm', 'npm', ['install', '-g', 'pnpm']))
  if (!ok) {
    if (serverPhase === 'starting') {
      addActivity('✗ pnpm install failed — run `npm install -g pnpm` in a terminal, then try again')
      void vscode.window.showErrorMessage('DeepSeek Harness: pnpm install failed. Run "npm install -g pnpm" in a terminal, then try again.')
    }
    return undefined
  }
  const after = await findPnpm()
  if (!after) {
    addActivity('✗ pnpm installed but not on PATH — restart VS Code, then try again')
    void vscode.window.showErrorMessage('DeepSeek Harness: pnpm was installed but is not on PATH yet. Restart VS Code, then try again.')
    return undefined
  }
  dshState = 'unknown'
  addActivity('✓ pnpm installed')
  return { command: after, allowBuild: pnpmSupportsDangerouslyAllowAllBuilds(await pnpmVersion(after)) }
}

/**
 * Locate the source checkout: the explicit `dsh.path` setting when it is a
 * valid checkout, else the launcher's managed clone.
 */
function findSourceCheckout(cfg: DshConfig): string | undefined {
  if (isDshCheckout(cfg.path)) return cfg.path
  const managed = managedSourceCheckout()
  return isDshCheckout(managed) ? managed : undefined
}

/** A source checkout resolved for a start: its path, and whether this start cloned it. */
interface SourceCheckout {
  path: string
  /** This start cloned the checkout (first install), so setup should follow without asking. */
  cloned: boolean
}

/** Make sure a source checkout exists: reuse one, or clone deepseek-harness into the managed dir. */
async function ensureSourceCheckout(cfg: DshConfig): Promise<SourceCheckout | undefined> {
  const existing = findSourceCheckout(cfg)
  if (existing) return { path: existing, cloned: false }
  // Nothing cloned yet: let the user pick the default or a custom location.
  const chosen = await chooseInstallDir('source', managedSourceCheckout())
  if (!chosen) return undefined
  // Persist the choice even when it is the managed default: the setting then
  // shows the actual clone path and pins it against future default changes.
  await saveDshSetting('path', chosen)
  // The picked folder may already be a checkout (e.g. the user pointed at
  // their own clone): reuse it instead of cloning into it, which git would
  // refuse for a non-empty folder anyway.
  if (isDshCheckout(chosen)) {
    addActivity('✓ Existing deepseek-harness checkout found — reusing it')
    return { path: chosen, cloned: false }
  }
  try {
    if (fs.readdirSync(chosen).length > 0) {
      addActivity(`✗ ${maskPath(chosen)} is not empty and is not a deepseek-harness checkout — pick an empty folder`)
      void vscode.window.showErrorMessage('DeepSeek Harness: that folder already contains files. Pick an empty folder or an existing deepseek-harness checkout.')
      return undefined
    }
  } catch {
    // Unreadable or not created yet: let the clone attempt surface the error.
  }
  dshState = 'missing'
  addActivity('✗ No dsh source checkout found — cloning deepseek-harness…')
  addActivity(`▶ Cloning deepseek-harness → ${chosen}`)
  const ok = await runInstalling(() => runInTerminal('Clone deepseek-harness', 'git', ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', chosen]))
  if (!ok || !isDshCheckout(chosen)) {
    // Suppress the failure report when Stop interrupted the clone: the user
    // asked for it, so the terminal error is noise, not news.
    if (serverPhase === 'starting') {
      addActivity('✗ clone failed — see the terminal output above')
      void vscode.window.showErrorMessage('DeepSeek Harness: could not clone deepseek-harness. Check your network and git, then try again.')
    }
    return undefined
  }
  addActivity('✓ deepseek-harness cloned')
  return { path: chosen, cloned: true }
}

/** Detect the local dsh version: a source checkout (source mode), else the managed install. */
function detectDshVersion(cfg: DshConfig): void {
  if (cfg.mode === 'source') {
    const checkout = findSourceCheckout(cfg)
    if (!checkout) {
      // No checkout configured: dsh is 'missing', so drop any stale version.
      dshVersion = ''
      return
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'apps', 'cli', 'package.json'), 'utf8'))
      dshVersion = pkg?.version ?? ''
    } catch {
      dshVersion = ''
    }
    return
  }
  // pkg mode: only the pkg install counts (Start reinstalls from the registry on demand).
  dshVersion = pkgInstalledVersion(cfg) ?? ''
}

interface DshDetection {
  state: ConditionState
  path: string
}

/** Detect dsh: source mode uses a checkout; pkg uses the managed pnpm install. */
async function detectDsh(cfg: DshConfig): Promise<DshDetection> {
  if (cfg.mode === 'source') {
    const checkout = findSourceCheckout(cfg)
    if (checkout) return { state: 'ok', path: checkout }
    // Not cloned yet; show the chosen path only once the clone has started
    // (the dir appears as soon as the user picks a location).
    const chosen = cfg.path && cfg.path.trim() !== '' ? cfg.path : managedSourceCheckout()
    return fs.existsSync(chosen)
      ? { state: 'unknown', path: chosen }
      : { state: 'unknown', path: '' }
  }
  if (!(await findPnpm())) return { state: 'missing', path: '' }
  const dir = pkgInstallDir(cfg)
  // 'ok' once installed; show the path as soon as it exists (install started).
  if (pkgInstalledVersion(cfg) !== undefined) return { state: 'ok', path: dir }
  return fs.existsSync(dir)
    ? { state: 'unknown', path: dir }
    : { state: 'unknown', path: '' }
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

/**
 * Stream the DSH log file (written via cmd redirection by the hidden-console
 * launcher) into the dashboard activity feed as it grows.
 */
function startLogTail(): void {
  stopLogTail()
  logTailBuffer = ''
  try {
    // Ensure the log file exists before watching it, otherwise fs.watch dies
    // on ENOENT and never recovers when cmd later creates the file.
    fs.closeSync(fs.openSync(logPath, 'a'))
    // Stream only output written after this point (the file is appended to).
    logTailOffset = fs.statSync(logPath).size
  } catch {
    logTailOffset = 0
    return
  }
  const pump = (): void => {
    let size: number
    try {
      size = fs.statSync(logPath).size
    } catch {
      return
    }
    if (size < logTailOffset) logTailOffset = 0 // file truncated by a fresh start
    if (size <= logTailOffset) return
    let fd: number | undefined
    try {
      fd = fs.openSync(logPath, 'r')
      const buf = Buffer.alloc(size - logTailOffset)
      const read = fs.readSync(fd, buf, 0, buf.length, logTailOffset)
      logTailOffset += read
      logTailBuffer += buf.subarray(0, read).toString()
      const lines = logTailBuffer.split(/\r?\n/)
      logTailBuffer = lines.pop() ?? ''
      for (const line of lines) displayLine(line)
    } catch {
      // File may be locked mid-write; retry on the next change event.
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  pump()
  logTailWatcher = fs.watch(logPath, () => pump())
  logTailWatcher.on('error', () => {})
  // fs.watch can miss appends on Windows; poll as a reliable fallback.
  logTailTimer = setInterval(() => pump(), LOG_TAIL_POLL_MS)
}

/** Stop streaming the server log into the dashboard (safe to call on deactivate). */
export function stopLogTail(): void {
  if (logTailTimer) {
    clearInterval(logTailTimer)
    logTailTimer = undefined
  }
  logTailWatcher?.close()
  logTailWatcher = undefined
  if (logTailBuffer) {
    const trimmed = logTailBuffer.trimEnd()
    if (trimmed) addActivity(trimmed)
    logTailBuffer = ''
  }
}

/**
 * Spawn the DSH server inside a hidden console on Windows. A hidden console
 * (SW_HIDE via Start-Process -WindowStyle Hidden) lets the tool subprocesses
 * DSH spawns (bash/pwsh) attach to it without flashing their own cmd windows,
 * unlike `windowsHide` (CREATE_NO_WINDOW), which leaves them console-less and
 * forces each child to create a new visible window.
 *
 * The server itself runs as `cmd /c ... > log 2>&1` so output lands in the log
 * file that the tailer streams into the dashboard; Start-Process must NOT use
 * -RedirectStandardOutput/Error, because that keeps the parent PowerShell alive
 * until the child exits (a PowerShell quirk with long-running children).
 * `-PassThru` echoes the cmd.exe PID, which stays alive for the server's
 * lifetime (cmd /c blocks on the server process).
 */
function spawnHiddenViaPowerShell(cmd: string, args: string[], cwd: string | undefined, env?: Record<string, string>): void {
  const program = quoteCmdArg(cmd)
  const rest = args.map(quoteCmdArg).join(' ')
  let run = rest ? `${program} ${rest}` : program
  if (env) {
    // The quoted `set "K=V"` form keeps cmd metacharacters out of the value.
    const setEnv = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join('&& ')
    run = `${setEnv}&& ${run}`
  }
  const inner = `${run} >> ${quoteCmdArg(logPath)} 2>&1`
  const wd = cwd ? `-WorkingDirectory '${psQuote(cwd)}' ` : ''
  const script =
    `$p = Start-Process -FilePath 'cmd.exe' ${wd}-ArgumentList '/d','/s','/c','${psQuote(inner)}' ` +
    `-WindowStyle Hidden -PassThru; Write-Output "DSH_PID=$($p.Id)"`

  startLogTail()

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    // NOTE: no `detached` here — on Windows it breaks powershell's stdio and
    // Start-Process (empirically verified). The server survives regardless,
    // because Start-Process launches it as an independent process.
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.unref()
  trackedChild = child

  let pidBuf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    pidBuf += chunk.toString()
    const m = /DSH_PID=(\d+)/.exec(pidBuf)
    if (m && trackedChild === child) trackedPid = Number(m[1])
  })
  child.stdout?.on('error', () => {})
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) addActivity(text)
  })
  child.stderr?.on('error', () => {})

  child.once('error', (error) => {
    // Do not clear trackedChild here: 'close' always follows and owns the
    // cleanup, so its fail-fast below can still observe the child. Clearing
    // early made the close guard dead code and left a dead spawn spinning in
    // waitForPort forever.
    void vscode.window.showErrorMessage(`DeepSeek Harness: failed to start (${error.message}).`)
  })
  // 'close' fires after 'exit' and after stdout is fully delivered; this
  // launcher exits right after Start-Process. If no PID was ever reported,
  // the server never came up — fail the start instead of letting waitForPort
  // spin forever.
  child.once('close', () => {
    if (trackedChild === child) trackedChild = undefined
    if (trackedPid === undefined && serverPhase === 'starting') {
      setServerPhase('stopped')
      addActivity('✗ Server failed to launch — no process id was reported (see the log above)')
    }
  })
}

/**
 * Spawn the DSH server with no console window (Windows) and stream its
 * stdout/stderr into the dashboard activity feed + log file.
 */
function spawnServer(cmd: string, args: string[], cwd: string | undefined, shell = false, env?: Record<string, string>): void {
  trackedPid = undefined
  moduleLoadCount = 0
  // Each run mints its own web token; drop the previous run's.
  webToken = undefined
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch {
    // Failing here used to escape as an unhandled rejection from the Start
    // command; report it and abort the spawn instead.
    addActivity('✗ Could not create the log folder — check write permissions under your home directory')
    void vscode.window.showErrorMessage(`DeepSeek Harness: could not create ${path.dirname(logPath)}. Check write permissions.`)
    return
  }
  // Each start gets a fresh server log (dsh.clearServerLogOnStart, default on)
  // — otherwise output from every previous run accumulates (NODE_DEBUG=module
  // alone produced a ~90MB file) and mixes with the current run.
  if (vscode.workspace.getConfiguration('dsh').get<boolean>('clearServerLogOnStart') ?? true) {
    try {
      fs.writeFileSync(logPath, '')
    } catch {
      // Best effort: a just-stopped server may still hold the file open.
    }
  }

  const hideConsole = vscode.workspace.getConfiguration('dsh').get<boolean>('hideConsole') ?? true

  if (process.platform === 'win32' && hideConsole) {
    spawnHiddenViaPowerShell(cmd, args, cwd, env)
    return
  }

  const child = spawn(cmd, args, {
    cwd,
    shell,
    windowsHide: hideConsole,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : undefined,
  })
  child.unref()
  trackedChild = child
  // Mirror the hidden-console path so waitForPort's fail-fast (which checks
  // trackedPid) also covers a directly-spawned child that exits immediately.
  trackedPid = child.pid

  let outBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    outBuffer += chunk.toString()
    const lines = outBuffer.split(/\r?\n/)
    outBuffer = lines.pop() ?? ''
    for (const line of lines) appendOutput(line)
  })
  child.stdout?.on('error', () => {})
  let errBuffer = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    errBuffer += chunk.toString()
    const lines = errBuffer.split(/\r?\n/)
    errBuffer = lines.pop() ?? ''
    for (const line of lines) appendOutput(line)
  })
  child.stderr?.on('error', () => {})

  child.once('error', (error) => {
    trackedChild = undefined
    void vscode.window.showErrorMessage(`DeepSeek Harness: failed to start (${error.message}).`)
  })
  child.once('exit', () => {
    trackedChild = undefined
  })
}

/**
 * The `web` command tail: the port, plus `--no-open` when dsh ≥ rc.8 would
 * open the system browser on its own. `version` is the exact version about
 * to run — passed explicitly because the `dshVersion` global is recomputed
 * by status refreshes and can be empty mid-install.
 */
function buildWebArgs(cfg: DshConfig, version: string): string[] {
  const args = ['web', '--port', String(cfg.port)]
  if (version && dshVersionAtLeast(version, DSH_NO_OPEN_MIN_VERSION)) args.push('--no-open')
  return args
}

/** Source mode: run a checkout via `node --import tsx/esm apps/cli/src/bin.ts web`. */
function spawnSource(repoPath: string, cfg: DshConfig, version: string): void {
  const node = cfg.nodePath || 'node'
  dshState = 'ok'
  addActivity('✓ dsh detected (source run)')
  addActivity('ℹ Source mode compiles TypeScript on the fly with tsx — the first start is slower, please wait')
  const webArgs = buildWebArgs(cfg, version)
  startBusyId = addActivity(`▶ Start: ${node} --import tsx/esm apps/cli/src/bin.ts ${webArgs.join(' ')}`, true)
  const env = cfg.sourceDebug ? { NODE_DEBUG: 'module' } : undefined
  spawnServer(node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...webArgs], repoPath, false, env)
}

/** pkg mode: run the managed dsh via `pnpm exec dsh web` (pnpm sets up the module path). */
function spawnPkg(cfg: DshConfig, pnpmCmd: string, version: string): void {
  dshState = 'ok'
  addActivity('✓ dsh detected (pkg run)')
  const webArgs = buildWebArgs(cfg, version)
  startBusyId = addActivity(`▶ Start: pnpm exec dsh ${webArgs.join(' ')}`, true)
  const dir = pkgInstallDir(cfg)
  if (process.platform === 'win32') {
    // pnpm is a .cmd shim: drive it through cmd with the arguments array, so
    // Windows quoting keeps fallback shim paths (possibly containing spaces)
    // intact in both the hidden-console and the visible-console spawn paths.
    spawnServer('cmd', ['/c', quoteCmdArg(pnpmCmd), 'exec', 'dsh', ...webArgs], dir, false)
  } else {
    spawnServer(pnpmCmd, ['exec', 'dsh', ...webArgs], dir, false)
  }
}

/** Poll the port until it opens, the spawned process dies, or the user stops. */
async function waitForPort(cfg: DshConfig): Promise<boolean> {
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
    if (trackedPid !== undefined && !isProcessAlive(trackedPid)) {
      setServerPhase('stopped')
      addActivity('✗ Server exited before opening the port (see the log above)')
      finishBusy(startBusyId)
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
function checkoutReady(checkout: string): boolean {
  return fs.existsSync(path.join(checkout, 'node_modules', 'tsx'))
    || fs.existsSync(path.join(checkout, 'node_modules', '.bin', 'tsx'))
}

/** Whether the checkout's installed deps predate its lockfile (a stale install). */
function checkoutDepsStale(checkout: string): boolean {
  try {
    const lock = fs.statSync(path.join(checkout, 'pnpm-lock.yaml')).mtimeMs
    const installed = fs.statSync(path.join(checkout, 'node_modules', '.pnpm', 'lock.yaml')).mtimeMs
    return lock > installed
  } catch {
    // Can't compare (missing marker): treat as not stale.
    return false
  }
}

/**
 * Make a checkout runnable: install its deps when missing/stale, then build
 * the web client with dsh's official profile so the UI shows the same
 * DeepSeek Harness brand as the packaged dsh. A checkout this start just
 * cloned (`freshClone`) is set up automatically — the user already committed
 * to the install by starting it, so a second "setup?" prompt right after the
 * clone only slows them down.
 */
async function ensureCheckoutReady(checkout: string, freshClone = false): Promise<boolean> {
  const stale = checkoutDepsStale(checkout)
  const depsReady = checkoutReady(checkout) && !stale
  if (!depsReady) {
    if (!freshClone) {
      const pick = await vscode.window.showInformationMessage(
        stale
          ? 'This deepseek-harness checkout has outdated dependencies. Run `pnpm install` and `pnpm run build`?'
          : 'This deepseek-harness checkout is not set up. Run `pnpm install` and `pnpm run build`?',
        'Setup now',
        'Cancel',
      )
      if (pick !== 'Setup now') {
        // The setup prompt was dismissed: say so in the console instead of
        // silently stopping after "Node.js detected".
        addActivity('✗ Setup declined — the checkout needs pnpm install + build before dsh can start')
        return false
      }
    } else {
      addActivity('ℹ Fresh clone — running the one-time setup (pnpm install + build) automatically')
    }
    // The phase is already 'starting' (set at the top of ensureRunningUnlocked),
    // so setup needs no extra flag handling — the panel spinner is driven by it.
    addActivity(`▶ Setup: pnpm --dir "${checkout}" install`)
    const installOk = await runInstalling(() => runInTerminal('Setup deepseek-harness (pnpm install)', 'pnpm', ['--dir', checkout, 'install', '--frozen-lockfile']))
    if (!installOk) {
      if (serverPhase === 'starting') {
        addActivity('✗ pnpm install failed')
        void vscode.window.showErrorMessage('DeepSeek Harness: pnpm install failed. Check the terminal output.')
      }
      return false
    }
  }
  // Build with the official profile whenever the current artifacts predate it.
  // The build record makes this idempotent: a checkout built locally or set up
  // by an older launcher version gets exactly one rebuild before the start.
  const needsBrandBuild = checkoutSupportsOfficialBuild(checkout) && !checkoutHasOfficialBrand(checkout)
  if (!depsReady || needsBrandBuild) {
    if (depsReady) {
      addActivity('ℹ Web UI lacks the official brand — rebuilding once so it matches the packaged dsh')
    }
    // Clear stale build outputs first: after a git pull, packages removed
    // from the tree leave orphan lib/ dirs behind (git does not delete ignored
    // files), and tsdown still globs them — breaking the build with
    // MISSING_EXPORT errors. dsh's own clean script removes that residue, so
    // the build below always starts from a clean tree. Older checkouts without
    // the script keep the previous behaviour.
    if (checkoutSupportsClean(checkout)) {
      addActivity(`▶ Setup: pnpm --dir "${checkout}" run clean`)
      const cleanOk = await runInstalling(() => runInTerminal('Setup deepseek-harness (pnpm run clean)', 'pnpm', ['--dir', checkout, 'run', 'clean']))
      if (!cleanOk) {
        // Do not hard-block: the build still gets a chance and reports its own
        // errors, but keep the clean failure visible for diagnosis.
        addActivity('⚠ pnpm run clean failed — continuing to the build anyway')
      }
    }
    addActivity(`▶ Setup: pnpm --dir "${checkout}" run build (official brand)`)
    const buildOk = await runInstalling(() => runInTerminal(
      'Setup deepseek-harness (pnpm run build)',
      'pnpm',
      ['--dir', checkout, 'run', 'build'],
      { [DSH_BUILD_PROFILE_SELECTOR]: DSH_BUILD_PROFILE_OFFICIAL },
    ))
    if (!buildOk) {
      if (serverPhase === 'starting') {
        addActivity('✗ pnpm run build failed')
        void vscode.window.showErrorMessage('DeepSeek Harness: pnpm run build failed. Check the terminal output.')
      }
      return false
    }
  }
  return checkoutReady(checkout)
}

/** Make sure the server is running (no re-entrancy guard). */
async function ensureRunningUnlocked(cfg: DshConfig): Promise<boolean> {
  detectDshVersion(cfg)
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

  // Enter the 'starting' phase from the very first await, so status refreshes
  // keep the Start button grey instead of un-greying it mid-setup.
  setServerPhase('starting')

  await checkNodeOnce()
  if (nodeState === 'missing') {
    addActivity(`✗ Node.js not found (need 22.x >= 22.${NODE_22_MIN_MINOR} or >= ${NODE_MIN_MAJOR})`)
    return false
  }

  if (cfg.mode === 'source') {
    const checkout = await ensureSourceCheckout(cfg)
    if (!checkout) return false
    if (!(await ensureCheckoutReady(checkout.path, checkout.cloned))) {
      dshState = 'missing'
      return false
    }
    // Setup may have run while the user pressed Stop; honour that request
    // instead of starting a server nobody is waiting for.
    if (serverPhase !== 'starting') return false
    spawnSource(checkout.path, cfg, dshVersion)
    return waitForPort(cfg)
  }

  // pkg mode: install dsh into the managed pnpm project, then run it (source needs explicit opt-in)
  const pnpmCmd = await ensurePnpmAvailable()
  if (!pnpmCmd) return false
  const version = await preparePkgStart(cfg, pnpmCmd.command, pnpmCmd.allowBuild)
  if (!version) return false
  // The install may have run while the user pressed Stop; honour that request
  // instead of starting a server nobody is waiting for.
  if (serverPhase !== 'starting') return false
  spawnPkg(cfg, pnpmCmd.command, version)
  return waitForPort(cfg)
}

/**
 * Make sure the server is running. Resolution: a source checkout (git clone)
 * or a managed pnpm install of the published dsh (`pnpm exec dsh web`).
 * Concurrent calls coalesce onto the in-flight run.
 */
export function ensureRunning(cfg: DshConfig = readConfig()): Promise<boolean> {
  return exclusive(() => ensureRunningUnlocked(cfg))
}

/** PID of the process listening on `port`, if any. Windows uses netstat, POSIX uses lsof. */
async function findPortOwner(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('netstat', ['-ano'], { windowsHide: true, timeout: NODE_PROBE_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`)
        for (const line of stdout.split(/\r?\n/)) {
          const match = re.exec(line)
          if (match) {
            resolve(Number(match[1]))
            return
          }
        }
        resolve(undefined)
      })
    })
  }
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${port}`], { windowsHide: true, timeout: NODE_PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      const pid = Number(stdout.trim().split(/\r?\n/)[0])
      resolve(Number.isFinite(pid) && pid > 0 ? pid : undefined)
    })
  })
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    // Kill the process tree: trackedPid is cmd.exe, and the node child that
    // `cmd /c` blocks on would otherwise survive and finish starting.
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, (error) => {
      if (error) dbg(`taskkill ${pid} failed: ${error.message}`)
    })
    return
  }
  try {
    process.kill(pid)
  } catch {
    // Process already exited.
  }
}

/** Stop the server, killing the tracked child and/or whatever owns the port (no guard). */
async function stopServerUnlocked(wasStarting: boolean): Promise<boolean> {
  const cfg = readConfig()
  const pids: number[] = []
  if (trackedPid) {
    pids.push(trackedPid)
    killPid(trackedPid)
    trackedPid = undefined
  }
  if (trackedChild?.pid) {
    pids.push(trackedChild.pid)
    killPid(trackedChild.pid)
    trackedChild = undefined
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
    killPid(owner)
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

/** Check for a newer dsh version: pkg compares the registry, source compares git upstream. */
async function checkDshUpdateStatus(cfg: DshConfig): Promise<DshUpdate> {
  if (cfg.mode === 'pnpm') {
    const installed = pkgInstalledVersion(cfg)
    if (!installed) return { hasUpdate: false, label: '' }
    const latest = await latestDshVersion(cfg.channel)
    if (!latest) {
      addActivity('⚠ Update check failed — could not resolve the latest dsh version')
      return { hasUpdate: false, label: '', failed: true }
    }
    if (latest !== installed && dshVersionAtLeast(latest, installed)) {
      return { hasUpdate: true, label: `v${latest}` }
    }
    return { hasUpdate: false, label: '' }
  }
  const checkout = findSourceCheckout(cfg)
  if (!checkout) return { hasUpdate: false, label: '' }
  const fetchResult = await runFile('git', ['-C', checkout, 'fetch'], GIT_OP_TIMEOUT_MS)
  if (!fetchResult.ok) {
    // Report the network failure instead of silently pretending there is no
    // update — the user should know the check could not run.
    const last = fetchResult.stderr.trim().split(/\r?\n/).pop()?.trim() || 'git fetch failed'
    addActivity(`⚠ Update check failed (network) — ${last}`)
    return { hasUpdate: false, label: '', failed: true }
  }
  const r = await runFile('git', ['-C', checkout, 'rev-list', '--count', 'HEAD..@{upstream}'], GIT_OP_TIMEOUT_MS)
  if (!r.ok) {
    addActivity('⚠ Update check failed — could not compare the checkout with its upstream')
    return { hasUpdate: false, label: '', failed: true }
  }
  const count = Number(r.stdout.trim())
  if (!Number.isFinite(count) || count <= 0) return { hasUpdate: false, label: '' }
  // Prefer the upstream version number; fall back to the commit count.
  let label = `${count} commit${count === 1 ? '' : 's'}`
  const v = await runFile('git', ['-C', checkout, 'show', '@{upstream}:apps/cli/package.json'], GIT_OP_TIMEOUT_MS)
  if (v.ok) {
    try {
      const pkg = JSON.parse(v.stdout)
      if (pkg?.version) label = `v${pkg.version}`
    } catch {
      // keep the commit-count label
    }
  }
  return { hasUpdate: true, label }
}

let updateInFlight = false

/** Update dsh: pkg reinstalls the latest published version; source pulls the checkout. */
export async function runDshUpdate(): Promise<void> {
  // No phase state covers an update, so guard it directly: coalesce repeat
  // clicks onto one run, and refuse to update while the server is up (a git
  // pull / pnpm install under a running dsh can break it).
  if (updateInFlight) {
    addActivity('↑ Update already in progress')
    return
  }
  if (serverPhase !== 'stopped') {
    addActivity('↑ Stop dsh before updating')
    return
  }
  updateInFlight = true
  try {
    await runDshUpdateInner()
  } finally {
    updateInFlight = false
  }
}

async function runDshUpdateInner(): Promise<void> {
  const cfg = readConfig()
  if (cfg.mode === 'pnpm') {
    const pnpm = await ensurePnpmAvailable()
    if (!pnpm) return
    const latest = await latestDshVersion(cfg.channel, pnpm.command)
    if (!latest) {
      addActivity('↑ Update check failed (network) — could not resolve the latest dsh version')
      return
    }
    if (pkgInstalledVersion(cfg) === latest) {
      addActivity('↑ dsh is already up to date')
      return
    }
    addActivity(`↑ Updating dsh to v${latest}…`)
    if (await ensureDshInstalled(latest, pnpm.command, pnpm.allowBuild, pkgInstallDir(cfg))) {
      addActivity('↑ dsh updated')
      updateCache = undefined
    }
    return
  }
  const checkout = findSourceCheckout(cfg)
  if (!checkout) {
    addActivity('↑ No source checkout configured')
    return
  }
  addActivity('↑ Updating dsh (git pull)…')
  const ok = await runInTerminal('Update DeepSeek Harness', 'git', ['-C', checkout, 'pull'])
  addActivity(ok ? '↑ dsh updated' : '↑ dsh update failed')
  if (ok) updateCache = undefined
}

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
    const dshDet = await detectDsh(cfg)
    dshState = dshDet.state
    dshPath = dshDet.path
    detectionCache = { dsh: dshDet, at: now }
    // Installing/starting is mid-flight: the package tree may not be ready yet,
    // and a re-detect here clobbers dshVersion (the panel version row flashes
    // a placeholder during first-run installs).
    if (serverPhase !== 'starting' && serverPhase !== 'installing') detectDshVersion(cfg)
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
    url: displayUrl(cfg),
    dsh: dshState,
    dshVersion,
    dshPath,
    dshHome,
    dshPathShort: maskPath(dshPath),
    dshHomeShort: maskPath(dshHome),
    nodeVersion,
    mode: cfg.mode === 'source' ? 'source' : 'pnpm',
    update: updateCache?.update,
    consoleLogPath: consolePath,
    consoleLogPathShort: maskPath(consolePath),
    serverLogPath: logPath,
    serverLogPathShort: maskPath(logPath),
    consoleLogSize: fileSizeSafe(consolePath),
    serverLogSize: fileSizeSafe(logPath),
    sourceDebug: cfg.sourceDebug,
  }
}

/** Force the next refresh to re-probe node/dsh and re-check for dsh updates. */
export async function clearRequirementsCaches(): Promise<void> {
  detectionCache = undefined
  updateCache = undefined
  checkingUpdates = true
  try {
    const update = await checkDshUpdateStatus(readConfig())
    updateCache = { update, at: Date.now() }
  } finally {
    checkingUpdates = false
  }
}

/** Mark the update check in-flight before the first refresh, so the button stays grey. */
export function setCheckingUpdates(value: boolean): void {
  checkingUpdates = value
}

/** Clear the console log (in-memory feed and the persisted file). */
export function clearConsole(): void {
  activity.length = 0
  for (const file of [consolePath, logPath]) {
    if (!file) continue
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '')
    } catch {
      // Only a real lock (EBUSY/EPERM from the running server) is worth
      // telling the user about; a missing folder is handled by the mkdir above.
      if (file === logPath) {
        pushActivity('⚠ Server log is locked by the running server — Stop first, then Clear')
      }
    }
  }
}
