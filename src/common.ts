import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'

// --- dsh ---

/** Marker path that identifies a deepseek-harness source checkout. */
const DSH_CLI_BIN = path.join('apps', 'cli', 'src', 'bin.ts')

/** Whether `dir` is a deepseek-harness source checkout (or the cli package itself). */
export function isDshCheckout(dir: string | undefined): boolean {
  if (!dir) return false
  try {
    if (fs.existsSync(path.join(dir, DSH_CLI_BIN))) return true
    // Also accept pointing directly at the cli package (e.g. .../apps/cli).
    if (fs.existsSync(path.join(dir, 'src', 'bin.ts')) && /apps[\\/]cli$/.test(dir)) return true
    return false
  } catch {
    return false
  }
}

/** dsh ≥ this version opens the system browser on its own; the launcher then passes `--no-open`. */
export const DSH_NO_OPEN_MIN_VERSION = '0.1.0-rc.8'

// --- server lifecycle state machine ---

/**
 * The dsh server lifecycle phase (the launcher's own view of it). `installing`
 * is the first-run setup (download / clone / build) before any spawn.
 */
export type ServerPhase = 'stopped' | 'installing' | 'starting' | 'running' | 'stopping'

/** Valid direct transitions between server lifecycle phases. */
const SERVER_PHASE_TRANSITIONS: Record<ServerPhase, ServerPhase[]> = {
  stopped: ['starting'],
  installing: ['starting', 'stopping', 'stopped'],
  starting: ['installing', 'running', 'stopping', 'stopped'],
  running: ['stopping'],
  stopping: ['stopped'],
}

/** Whether a transition from → to is allowed. */
export function canTransition(from: ServerPhase, to: ServerPhase): boolean {
  return SERVER_PHASE_TRANSITIONS[from].includes(to)
}

// --- Timing (ms) ---

export const PORT_PROBE_TIMEOUT_MS = 500
export const PORT_POLL_INTERVAL_MS = 500
export const STOP_POLL_INTERVAL_MS = 200
export const STOP_POLL_ATTEMPTS = 10
export const STOP_POLL_PROBE_MS = 300
export const DETECTION_CACHE_TTL_MS = 8_000
export const HTTP_PROBE_TIMEOUT_MS = 2_000
export const NODE_PROBE_TIMEOUT_MS = 8_000
export const PNPM_PROBE_TIMEOUT_MS = 8_000
export const PNPM_VIEW_TIMEOUT_MS = 10_000
export const GIT_OP_TIMEOUT_MS = 10_000
export const MODULE_PROGRESS_EVERY = 500
export const LOG_TAIL_POLL_MS = 500

// --- Defaults ---

/** The port the web UI listens on when `dsh.port` is unset (mirrors package.json). */
export const DEFAULT_PORT = 3080

/** Highest valid TCP port; `dsh.port` values above this are clamped back to the default. */
export const MAX_PORT = 65535

/** Manifest name the launcher writes into its managed pkg install dir (a private marker). */
export const DSH_INSTALL_MANIFEST_NAME = 'dsh-install'

/** The root package.json script that builds with the official client profile. */
export const BUILD_OFFICIAL_SCRIPT = 'build:official'

/** The root package.json script that clears generated build state and orphan package residue. */
export const BUILD_CLEAN_SCRIPT = 'clean'

// --- Limits ---

export const ACTIVITY_MAX_LINES = 200
export const LOG_RELOAD_LINES = 50

// --- dsh home ---

/**
 * The DSH user-data root (matches dsh-home-paths precedence: `$DSH_HOME`,
 * else `~/.dsh`).
 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env && env.trim() !== '') return env
  return path.join(os.homedir(), '.dsh')
}

// --- Pure helpers ---

/** Compare dsh versions like '0.1.0-rc.8' numerically (rc.10 > rc.9, rc.8 > rc.7). */
export function dshVersionAtLeast(version: string, target: string): boolean {
  const parts = (v: string): (number | string)[] => v.split(/[-.]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  const a = parts(version)
  const b = parts(target)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return false
    if (y === undefined) return true
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y
    } else {
      const sx = String(x)
      const sy = String(y)
      if (sx !== sy) return sx > sy
    }
  }
  return true
}

/**
 * One-line summary of the last dsh update check for the panel console. A
 * failed check must never read as "up to date" — it is reported as failed.
 */
export function describeDshUpdate(update: { hasUpdate: boolean; label: string; failed?: boolean } | undefined): string {
  if (update?.failed) return '⚠ Update check failed'
  if (update?.hasUpdate) return `✓ Update available → ${update.label}`
  return '✓ dsh is up to date'
}

/** Strip non-ASCII characters and trailing parentheticals to yield an English name. */
export function toEnglish(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The one-time web access token dsh ≥ 0.1.2-alpha.1 prints in its startup URL. */
const WEB_TOKEN_RE = /[?&]token=([A-Za-z0-9_-]{8,})/

/** Extract the web access token from a server output line (undefined when absent). */
export function extractWebToken(line: string): string | undefined {
  return WEB_TOKEN_RE.exec(line)?.[1]
}

/** Whether a process id is still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Quote a single token for cmd.exe (only when it contains special characters). */
export function quoteCmdArg(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg
}

/** Escape a value for a PowerShell single-quoted string literal ('' doubles a quote). */
export function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run a command without a shell (no cmd window flash on Windows); `timeoutMs` bounds a hung probe. */
export function runFile(command: string, args: string[], timeoutMs = 0): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs > 0 ? timeoutMs : undefined }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/**
 * Whether a pnpm version (like '11.22.0') supports install's
 * --dangerously-allow-all-builds flag (pnpm ≥ 10.16), which approves
 * dependency build scripts non-interactively — the same thing npm does by
 * default on every install.
 */
export function pnpmSupportsDangerouslyAllowAllBuilds(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 10 || (major === 10 && minor >= 16)
}

// --- managed dirs (package / source / logs) ---

/**
 * The launcher's managed base dir: directly under the user's home directory
 * (%USERPROFILE% on Windows), dot-prefixed like dsh's own `~/.dsh`. It lives
 * outside the platform data dirs (LOCALAPPDATA / Library/Application Support /
 * XDG data home) because those are frequent targets of enterprise policy and
 * permission problems.
 */
export function dshBaseDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    const base = env.USERPROFILE && env.USERPROFILE.trim() !== '' ? env.USERPROFILE : home
    return path.join(base, '.dsh-launcher-panel')
  }
  return path.join(home, '.dsh-launcher-panel')
}

/** The installed @deepseek-ai/dsh version under a managed install dir (undefined when absent). */
export function installedDshVersion(installDir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: string }
    return pkg?.version || undefined
  } catch {
    // not installed
  }
  return undefined
}

/**
 * Whether a directory may be used as a managed dsh install target: absent,
 * empty, already a launcher-written manifest (`dsh-install`), or already an
 * installed dsh. Anything else may hold the user's own files, and installing
 * into it would overwrite them.
 */
export function isDshInstallDirUsable(dir: string): boolean {
  if (!fs.existsSync(dir)) return true
  try {
    if (fs.readdirSync(dir).length === 0) return true
  } catch {
    return false
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
    if (pkg?.name === DSH_INSTALL_MANIFEST_NAME) return true
  } catch {
    // no manifest (or not ours)
  }
  return installedDshVersion(dir) !== undefined
}

// --- official client build (the web UI brand shipped by published dsh) ---

/** Build selector env var: dsh's root build embeds the official brand when set to the official profile. */
export const DSH_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'

/** Public value dsh records in the client build record for official-profile builds. */
export const DSH_CLIENT_BUILD_PROFILE_KEY = 'DSH_CLIENT_BUILD_PROFILE'

/** The profile value that produces the official DeepSeek Harness brand. */
export const DSH_BUILD_PROFILE_OFFICIAL = 'official'

/** Relative path of dsh's client build record inside a checkout. */
export const CLIENT_BUILD_RECORD_REL = path.join('.dsh-build', 'client-build-environment.json')

/** Whether a checkout's root build ships the official profile (`build:official` script). */
export function checkoutSupportsOfficialBuild(checkout: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return typeof pkg.scripts?.[BUILD_OFFICIAL_SCRIPT] === 'string'
  } catch {
    // not a readable manifest
  }
  return false
}

/** Whether a checkout's root build ships the `clean` script (dsh's residue cleaner). */
export function checkoutSupportsClean(checkout: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return typeof pkg.scripts?.[BUILD_CLEAN_SCRIPT] === 'string'
  } catch {
    // not a readable manifest
  }
  return false
}

/** Whether a checkout's web client was built with the official DeepSeek Harness brand. */
export function checkoutHasOfficialBrand(checkout: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(checkout, CLIENT_BUILD_RECORD_REL), 'utf8')) as {
      environment?: Record<string, string | undefined>
    }
    return record?.environment?.[DSH_CLIENT_BUILD_PROFILE_KEY] === DSH_BUILD_PROFILE_OFFICIAL
  } catch {
    // no build record yet
  }
  return false
}

/** Candidate pnpm.cmd shim locations on Windows (npm global bin, pnpm standalone installer). */
export function windowsPnpmCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'pnpm.cmd'))
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'pnpm', 'pnpm.cmd'))
  return out
}

/**
 * Resolve the pnpm command: PATH first (bare `pnpm` on Windows, so cmd's
 * PATHEXT picks pnpm.cmd), then the known Windows shim locations.
 */
export async function findPnpm(): Promise<string | undefined> {
  const onPath = await findOnPath('pnpm')
  if (onPath) return process.platform === 'win32' ? 'pnpm' : onPath
  if (process.platform !== 'win32') return undefined
  for (const candidate of windowsPnpmCandidates(process.env)) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // unreadable location
    }
  }
  return undefined
}

/** Resolve a command on PATH (returns the first match, or undefined). */
async function findOnPath(cmd: string): Promise<string | undefined> {
  const which = process.platform === 'win32' ? 'where' : 'which'
  const result = await runFile(which, [cmd], PNPM_PROBE_TIMEOUT_MS)
  if (!result.ok) return undefined
  const first = result.stdout.trim().split(/\r?\n/)[0]
  return first || undefined
}

/** Abbreviate a path for display: keep the drive and the last segment, mask the middle. */
export function maskPath(p: string): string {
  if (!p) return ''
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (segs.length <= 3) return p
  if (/^[A-Za-z]:$/.test(segs[0])) return segs[0] + '\\…\\' + segs[segs.length - 1]
  return '…/' + segs[segs.length - 1]
}
