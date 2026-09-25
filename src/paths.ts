/**
 * Where the launcher keeps things, and how it reads what dsh puts there.
 *
 * Two different homes are involved and the distinction matters: dsh's own
 * user-data root (`~/.dsh`, shared with every other dsh entry point) and the
 * launcher's managed base dir (only this extension writes it).
 *
 * @module paths
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Manifest name the launcher writes into its managed pkg install dir (a private marker). */
export const DSH_INSTALL_MANIFEST_NAME = 'dsh-install'

/** Relative path of dsh's client build record inside a checkout. */
export const CLIENT_BUILD_RECORD_REL = path.join('.dsh-build', 'client-build-environment.json')

/** Marker path that identifies a deepseek-harness source checkout. */
const DSH_CLI_BIN = path.join('apps', 'cli', 'src', 'bin.ts')

/**
 * The DSH user-data root (matches dsh-home-paths precedence: `$DSH_HOME`,
 * else `~/.dsh`).
 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env && env.trim() !== '') return env
  return path.join(os.homedir(), '.dsh')
}

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

/** Read and parse a JSON file, or undefined when it is absent or unreadable. */
function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    // absent, unreadable, or not JSON
  }
  return undefined
}

/** The installed @deepseek-ai/dsh version under a managed install dir (undefined when absent). */
export function installedDshVersion(installDir: string): string | undefined {
  const pkg = readJson<{ version?: string }>(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return pkg?.version || undefined
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
  const pkg = readJson<{ name?: string }>(path.join(dir, 'package.json'))
  if (pkg?.name === DSH_INSTALL_MANIFEST_NAME) return true
  return installedDshVersion(dir) !== undefined
}

/** The scripts block of a checkout's root package.json, or undefined when unreadable. */
function checkoutScripts(checkout: string): Record<string, string> | undefined {
  return readJson<{ scripts?: Record<string, string> }>(path.join(checkout, 'package.json'))?.scripts
}

/** Whether a checkout's root build ships the official profile (`build:official` script). */
export function checkoutSupportsOfficialBuild(checkout: string): boolean {
  return typeof checkoutScripts(checkout)?.[BUILD_OFFICIAL_SCRIPT] === 'string'
}

/** Whether a checkout's root build ships the `clean` script (dsh's residue cleaner). */
export function checkoutSupportsClean(checkout: string): boolean {
  return typeof checkoutScripts(checkout)?.[BUILD_CLEAN_SCRIPT] === 'string'
}

/** The environment record dsh writes into its client build record. */
interface ClientBuildRecord {
  environment?: Record<string, string | undefined>
}

/** Read a checkout's client build record, or undefined when it is absent. */
function clientBuildEnvironment(checkout: string): Record<string, string | undefined> | undefined {
  return readJson<ClientBuildRecord>(path.join(checkout, CLIENT_BUILD_RECORD_REL))?.environment
}

/** Whether a checkout's web client was built with the official DeepSeek Harness brand. */
export function checkoutHasOfficialBrand(checkout: string): boolean {
  return clientBuildEnvironment(checkout)?.[DSH_CLIENT_BUILD_PROFILE_KEY] === DSH_BUILD_PROFILE_OFFICIAL
}

/** The commit hash dsh's client build record was built from (undefined when absent). */
export function clientBuildCommit(checkout: string): string | undefined {
  const hash = clientBuildEnvironment(checkout)?.[DSH_CLIENT_COMMIT_HASH]?.trim()
  return hash ? hash : undefined
}

/** Whether a checkout has its dependencies installed (`tsx` is the source-launch hook). */
export function checkoutReady(checkout: string): boolean {
  return fs.existsSync(path.join(checkout, 'node_modules', 'tsx'))
    || fs.existsSync(path.join(checkout, 'node_modules', '.bin', 'tsx'))
}

/**
 * Whether the checkout's installed deps predate its lockfile (a stale install).
 *
 * Compares two mtimes that pnpm writes: the lockfile and its record of what was
 * installed. An unreadable marker means "not stale" — a missing file is not
 * evidence of an outdated install.
 */
export function checkoutDepsStale(checkout: string): boolean {
  try {
    const lock = fs.statSync(path.join(checkout, 'pnpm-lock.yaml')).mtimeMs
    const installed = fs.statSync(path.join(checkout, 'node_modules', '.pnpm', 'lock.yaml')).mtimeMs
    return lock > installed
  } catch {
    // Can't compare (missing marker): treat as not stale.
    return false
  }
}

/** Abbreviate a path for display: keep the drive and the last segment, mask the middle. */
export function maskPath(p: string): string {
  if (!p) return ''
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (segs.length <= 3) return p
  if (/^[A-Za-z]:$/.test(segs[0])) return segs[0] + '\\…\\' + segs[segs.length - 1]
  return '…/' + segs[segs.length - 1]
}

// --- Official client build (the web UI brand shipped by published dsh) ---

/** Build selector env var: dsh's root build embeds the official brand when set to the official profile. */
export const DSH_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'

/** Public value dsh records in the client build record for official-profile builds. */
export const DSH_CLIENT_BUILD_PROFILE_KEY = 'DSH_CLIENT_BUILD_PROFILE'

/** Public key dsh records in the client build record for official-profile builds (built commit). */
export const DSH_CLIENT_COMMIT_HASH = 'DSH_CLIENT_COMMIT_HASH'

/** The profile value that produces the official DeepSeek Harness brand. */
export const DSH_BUILD_PROFILE_OFFICIAL = 'official'

/** The root package.json script that builds with the official client profile. */
export const BUILD_OFFICIAL_SCRIPT = 'build:official'

/** The root package.json script that clears generated build state and orphan package residue. */
export const BUILD_CLEAN_SCRIPT = 'clean'
