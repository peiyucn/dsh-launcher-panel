import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const DSH_INSTALL_MANIFEST_NAME = 'dsh-install'

export const CLIENT_BUILD_RECORD_REL = path.join('.dsh-build', 'client-build-environment.json')

const DSH_CLI_BIN = path.join('apps', 'cli', 'src', 'bin.ts')

// Must match dsh-home-paths precedence so every dsh entry point resolves the same root.
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env && env.trim() !== '') return env
  return path.join(os.homedir(), '.dsh')
}

// Deliberately outside LOCALAPPDATA/Application Support/XDG data: enterprise policy hits those.
export function dshBaseDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const base = platform === 'win32' && env.USERPROFILE && env.USERPROFILE.trim() !== '' ? env.USERPROFILE : home
  return path.join(base, '.dsh-launcher-panel')
}

// The value is a user setting, so trim and resolve it: a trailing separator would defeat the apps/cli regex.
export function isDshCheckout(dir: string | undefined): boolean {
  if (!dir) return false
  try {
    const trimmed = dir.trim()
    if (trimmed === '') return false
    const root = path.resolve(trimmed)
    if (fs.existsSync(path.join(root, DSH_CLI_BIN))) return true
    return fs.existsSync(path.join(root, 'src', 'bin.ts')) && /apps[\\/]cli$/.test(root)
  } catch {
    return false
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function manifestName(dir: string): string | undefined {
  return readJson<{ name?: string }>(path.join(dir, 'package.json'))?.name
}

export function installedDshVersion(installDir: string): string | undefined {
  const pkg = readJson<{ version?: string }>(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return pkg?.version || undefined
}

export function isDshInstallDirUsable(dir: string): boolean {
  if (!fs.existsSync(dir)) return true
  try {
    if (fs.readdirSync(dir).length === 0) return true
  } catch {
    return false
  }
  return manifestName(dir) === DSH_INSTALL_MANIFEST_NAME || installedDshVersion(dir) !== undefined
}

// An unreadable manifest cannot be proven ours, so it is left untouched.
export function installManifestRepairable(dir: string): boolean {
  const manifest = path.join(dir, 'package.json')
  return !fs.existsSync(manifest) || manifestName(dir) === DSH_INSTALL_MANIFEST_NAME
}

// The ownership check lives in the writer so no caller can bypass it.
export function writeInstallManifest(version: string, dir: string): boolean {
  if (!installManifestRepairable(dir)) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: DSH_INSTALL_MANIFEST_NAME, private: true, dependencies: { '@deepseek-ai/dsh': version } }, null, 2) + '\n',
    )
    return true
  } catch {
    return false
  }
}

function checkoutScripts(checkout: string): Record<string, string> | undefined {
  return readJson<{ scripts?: Record<string, string> }>(path.join(checkout, 'package.json'))?.scripts
}

export function checkoutSupportsOfficialBuild(checkout: string): boolean {
  return typeof checkoutScripts(checkout)?.[BUILD_OFFICIAL_SCRIPT] === 'string'
}

export function checkoutSupportsClean(checkout: string): boolean {
  return typeof checkoutScripts(checkout)?.[BUILD_CLEAN_SCRIPT] === 'string'
}

function clientBuildEnvironment(checkout: string): Record<string, string | undefined> | undefined {
  return readJson<{ environment?: Record<string, string | undefined> }>(path.join(checkout, CLIENT_BUILD_RECORD_REL))?.environment
}

export function checkoutHasOfficialBrand(checkout: string): boolean {
  return clientBuildEnvironment(checkout)?.[DSH_CLIENT_BUILD_PROFILE_KEY] === DSH_BUILD_PROFILE_OFFICIAL
}

export function clientBuildCommit(checkout: string): string | undefined {
  return clientBuildEnvironment(checkout)?.[DSH_CLIENT_COMMIT_HASH]?.trim() || undefined
}

export function checkoutReady(checkout: string): boolean {
  return fs.existsSync(path.join(checkout, 'node_modules', 'tsx'))
    || fs.existsSync(path.join(checkout, 'node_modules', '.bin', 'tsx'))
}

// A missing marker is not evidence of a stale install.
export function checkoutDepsStale(checkout: string): boolean {
  try {
    return fs.statSync(path.join(checkout, 'pnpm-lock.yaml')).mtimeMs
      > fs.statSync(path.join(checkout, 'node_modules', '.pnpm', 'lock.yaml')).mtimeMs
  } catch {
    return false
  }
}

export function maskPath(p: string): string {
  if (!p) return ''
  const segs = p.split(/[\\/]+/).filter(Boolean)
  if (segs.length <= 3) return p
  return /^[A-Za-z]:$/.test(segs[0]) ? segs[0] + '\\…\\' + segs[segs.length - 1] : '…/' + segs[segs.length - 1]
}

// Only local drive roots are probed; an offline UNC share could block the probe.
export function driveRootExists(target: string): boolean {
  const root = path.parse(path.resolve(target)).root
  return !/^[A-Za-z]:[\\/]$/.test(root) || fs.existsSync(root)
}

// Keys and values dsh's root build writes into .dsh-build; keep in sync with upstream.
export const DSH_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'
export const DSH_CLIENT_BUILD_PROFILE_KEY = 'DSH_CLIENT_BUILD_PROFILE'
export const DSH_CLIENT_COMMIT_HASH = 'DSH_CLIENT_COMMIT_HASH'
export const DSH_BUILD_PROFILE_OFFICIAL = 'official'
export const BUILD_OFFICIAL_SCRIPT = 'build:official'
export const BUILD_CLEAN_SCRIPT = 'clean'
