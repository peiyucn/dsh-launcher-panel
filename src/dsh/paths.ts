import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PackageImportMethod } from '../shared/env.ts'

export const DSH_INSTALL_MANIFEST_NAME = 'dsh-install'

export const CLIENT_BUILD_RECORD_REL = path.join('.dsh-build', 'client-build-environment.json')

const DSH_CLI_BIN = path.join('apps', 'cli', 'src', 'bin.ts')

export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env && env.trim() !== '') return env
  return path.join(os.homedir(), '.dsh')
}

export function dshBaseDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const base = platform === 'win32' && env.USERPROFILE && env.USERPROFILE.trim() !== '' ? env.USERPROFILE : home
  return path.join(base, '.dsh-launcher-panel')
}

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

export function installManifestRepairable(dir: string): boolean {
  const manifest = path.join(dir, 'package.json')
  return !fs.existsSync(manifest) || manifestName(dir) === DSH_INSTALL_MANIFEST_NAME
}

export function writeInstallManifest(version: string, dir: string, packageImportMethod?: PackageImportMethod): boolean {
  if (!installManifestRepairable(dir)) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'package.json')
    const previous = readJson<{ dshLauncher?: unknown }>(file)
    const launcher = packageImportMethod !== undefined
      ? { packageImportMethod }
      : previous?.dshLauncher
    const body: Record<string, unknown> = {
      name: DSH_INSTALL_MANIFEST_NAME,
      private: true,
      dependencies: { '@deepseek-ai/dsh': version },
    }
    if (launcher !== undefined) body.dshLauncher = launcher
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

export function installedPackageImportMethod(dir: string): PackageImportMethod | undefined {
  const value = readJson<{ dshLauncher?: { packageImportMethod?: string } }>(path.join(dir, 'package.json'))
    ?.dshLauncher?.packageImportMethod
  return value === 'auto' || value === 'copy' || value === 'hardlink' ? value : undefined
}

export function installUsesHardlinks(dir: string): boolean {
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const files: string[] = []
  const walk = (current: string): void => {
    if (files.length >= 20) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= 20) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(pkgDir)
  return files.some((file) => {
    try {
      return fs.statSync(file).nlink > 1
    } catch {
      return false
    }
  })
}

export function effectivePackageImportMethod(dir: string): PackageImportMethod | undefined {
  if (!fs.existsSync(dir)) return undefined
  return installedPackageImportMethod(dir) ?? (installUsesHardlinks(dir) ? 'hardlink' : 'copy')
}

export function importMethodNeedsConversion(dir: string, configured: PackageImportMethod): boolean {
  const actual = effectivePackageImportMethod(dir)
  return actual !== undefined && actual !== configured
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

export function driveRootExists(target: string): boolean {
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(target)) return false
  const root = path.parse(path.resolve(target)).root
  return !/^[A-Za-z]:[\\/]$/.test(root) || fs.existsSync(root)
}

export const DSH_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'
export const DSH_CLIENT_BUILD_PROFILE_KEY = 'DSH_CLIENT_BUILD_PROFILE'
export const DSH_CLIENT_COMMIT_HASH = 'DSH_CLIENT_COMMIT_HASH'
export const DSH_BUILD_PROFILE_OFFICIAL = 'official'
export const BUILD_OFFICIAL_SCRIPT = 'build:official'
export const BUILD_CLEAN_SCRIPT = 'clean'
