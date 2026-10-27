import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { dshBaseDir, driveRootExists, installManifestRepairable, installedDshVersion, isDshCheckout, isDshInstallDirUsable, maskPath, writeInstallManifest } from './paths.ts'
import { npmSpecForChannel, type NpmChannel } from '../shared/env.ts'
import { PNPM_PROBE_TIMEOUT_MS, PNPM_VIEW_TIMEOUT_MS } from '../shared/timing.ts'
import { resolveCommandEntry, runResolved } from '../shared/proc.ts'
import { findPnpm, pnpmSupportsDangerouslyAllowAllBuilds } from './pnpm.ts'
import { reportStepFailure } from './terminal.ts'

export interface InstallHost {
  addActivity: (line: string, isBusy?: boolean) => number
  withBusy: <T>(label: string, task: () => Promise<T>) => Promise<T>
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
  setDshVersion: (version: string) => void
  setDshState: (state: 'unknown' | 'ok' | 'missing') => void
  dbg: (line: string) => void
}

export function managedPackageDir(): string {
  return path.join(dshBaseDir(), 'package')
}

export function managedSourceCheckout(): string {
  return path.join(dshBaseDir(), 'source')
}

export function pkgInstallDir(cfg: { pkgPath: string }): string {
  const custom = cfg.pkgPath.trim()
  // The setting may have been synchronized from a machine that had this drive.
  return custom !== '' && driveRootExists(custom) ? custom : managedPackageDir()
}

export function unreachablePkgPath(cfg: { pkgPath: string }): string | undefined {
  const custom = cfg.pkgPath.trim()
  return custom !== '' && !driveRootExists(custom) ? custom : undefined
}

export function pkgInstalledVersion(cfg: { pkgPath: string }): string | undefined {
  return installedDshVersion(pkgInstallDir(cfg))
}

async function chooseInstallDir(kind: 'pkg' | 'source', defaultDir: string): Promise<string | undefined> {
  const pick = await vscode.window.showInformationMessage(
    `Install dsh (${kind}) to the default location?`,
    'Use default location',
    'Choose folder…',
  )
  if (pick === 'Use default location') return defaultDir
  if (pick !== 'Choose folder…') return undefined
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select install folder',
    title: `Choose where to install dsh (${kind})`,
  })
  return picked?.[0]?.fsPath
}

async function saveDshSetting(key: 'srcPath' | 'pkgPath', value: string): Promise<boolean> {
  const c = vscode.workspace.getConfiguration('dsh')
  if ((c.get<string>(key) ?? '') === value) return true
  try {
    await c.update(key, value, vscode.ConfigurationTarget.Global)
    return true
  } catch {
    // A registry that does not know the setting yet must not abort the install.
    return false
  }
}

export async function latestDshVersion(
  channel: NpmChannel,
  dbg: (line: string) => void,
  pnpmCmd?: string,
): Promise<{ version: string } | { error: string; pnpmUnusable?: boolean }> {
  const spec = npmSpecForChannel(channel)
  const command = pnpmCmd ?? await findPnpm()
  if (command === undefined) return { error: 'pnpm was not found on PATH', pnpmUnusable: true }
  // A bare `pnpm` is not spawnable on Windows; resolve the shim to its target.
  const resolution = resolveCommandEntry(command)
  if (!resolution.ok) {
    const error = `${maskPath(command)} cannot be launched: ${resolution.reason}`
    dbg(`pnpm shim unresolved: ${error}`)
    return { error, pnpmUnusable: true }
  }
  const result = await runResolved(command, ['view', spec, 'version'], PNPM_VIEW_TIMEOUT_MS)
  if (result.ok) {
    const version = result.stdout.trim().split(/\r?\n/).pop()?.trim()
    return version ? { version } : { error: `the registry returned no version for ${spec}` }
  }
  const error = result.error ?? `could not resolve ${spec}`
  dbg(`pnpm view failed: ${error}`)
  return { error }
}

export async function ensureDshInstalled(
  version: string, pnpmCmd: string, allowBuild: boolean, dir: string, host: InstallHost,
): Promise<boolean> {
  if (!isDshInstallDirUsable(dir)) {
    reportStepFailure(
      host,
      `✗ ${maskPath(dir)} is not empty — install into an empty or dedicated folder instead`,
      `DeepSeek Harness: ${maskPath(dir)} is not empty. Choose an empty or dedicated folder for the dsh install.`,
    )
    return false
  }
  // A usable folder can still hold the user's own package.json; never replace it.
  if (!installManifestRepairable(dir)) {
    host.addActivity(`ℹ ${maskPath(dir)} already contains a dsh install with its own package.json — leaving that file untouched`)
  } else if (!writeInstallManifest(version, dir)) {
    host.addActivity('✗ could not write the dsh install manifest — check write permissions')
    return false
  }
  host.addActivity(`▶ Installing dsh v${version} (pnpm install)…`)
  const args = ['install', '--dir', dir]
  if (allowBuild) args.push('--dangerously-allow-all-builds')
  const ok = await host.runInstalling(() => host.runInTerminal(`Install dsh v${version}`, pnpmCmd, args))
  if (ok && installedDshVersion(dir) === version) return true
  reportStepFailure(
    host,
    '✗ dsh install failed — see the terminal output above',
    'DeepSeek Harness: dsh install failed. Check the terminal output.',
  )
  return false
}

export async function preparePkgStart(
  cfg: { pkgPath: string; npmChannel: NpmChannel }, pnpmCmd: string, allowBuild: boolean, host: InstallHost,
): Promise<string | undefined> {
  const dir = pkgInstallDir(cfg)
  const installed = installedDshVersion(dir)
  if (installed !== undefined) {
    // The installed version is what runs; the channel only governs future installs.
    if (!writeInstallManifest(installed, dir)) {
      host.dbg('install manifest not rewritten (absent ownership or write failure); continuing with the installed dsh')
    }
    host.setDshVersion(installed)
    return installed
  }
  const resolved = await host.withBusy('ℹ Resolving the dsh channel version…', () => latestDshVersion(cfg.npmChannel, host.dbg, pnpmCmd))
  if ('error' in resolved) {
    host.setDshState('missing')
    if (resolved.pnpmUnusable) {
      reportStepFailure(
        host,
        `✗ pnpm cannot be launched: ${resolved.error} — reinstall it ("npm install -g pnpm"), then try again`,
        'DeepSeek Harness: pnpm is installed but cannot be launched. Run "npm install -g pnpm" in a terminal, then try again.',
      )
      return undefined
    }
    reportStepFailure(
      host,
      `✗ dsh is not installed and the registry is unreachable (${resolved.error}) — check your network and try again`,
      'DeepSeek Harness: unable to reach the registry to install dsh. Check your network connection.',
    )
    return undefined
  }
  const version = resolved.version
  let installDir = dir
  if (!cfg.pkgPath) {
    const chosen = await chooseInstallDir('pkg', managedPackageDir())
    if (!chosen) return undefined
    // Persist the default too: an explicit value pins the install against a future default change.
    if (!(await saveDshSetting('pkgPath', chosen))) {
      host.addActivity(`⚠ could not remember dsh.pkgPath — installing to ${maskPath(chosen)} for this session; reload the window if the extension was just installed or updated`)
    }
    installDir = chosen
  }
  host.addActivity(`ℹ dsh v${version} — installing it now (first run, can take a few minutes)`)
  host.setDshVersion(version)
  return (await ensureDshInstalled(version, pnpmCmd, allowBuild, installDir, host)) ? version : undefined
}

async function pnpmVersion(pnpmCmd: string): Promise<string> {
  const result = await runResolved(pnpmCmd, ['--version'], PNPM_PROBE_TIMEOUT_MS)
  return result.ok ? result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '' : ''
}

export async function ensurePnpmAvailable(host: InstallHost): Promise<{ command: string; allowBuild: boolean } | undefined> {
  const found = await findPnpm()
  if (found) return { command: found, allowBuild: pnpmSupportsDangerouslyAllowAllBuilds(await pnpmVersion(found)) }
  host.setDshState('missing')
  host.addActivity('✗ pnpm not found — installing it now (npm install -g pnpm)')
  host.addActivity('▶ Installing pnpm (npm install -g pnpm)…')
  const ok = await host.runInstalling(() => host.runInTerminal('Install pnpm', 'npm', ['install', '-g', 'pnpm']))
  if (!ok) {
    reportStepFailure(
      host,
      '✗ pnpm install failed — run `npm install -g pnpm` in a terminal, then try again',
      'DeepSeek Harness: pnpm install failed. Run "npm install -g pnpm" in a terminal, then try again.',
    )
    return undefined
  }
  // Drop the cached "not found" answer so the shim this just installed is seen.
  const after = await findPnpm(true)
  if (!after) {
    reportStepFailure(
      host,
      '✗ pnpm installed but not on PATH — restart VS Code, then try again',
      'DeepSeek Harness: pnpm was installed but is not on PATH yet. Restart VS Code, then try again.',
    )
    return undefined
  }
  host.setDshState('unknown')
  host.addActivity('✓ pnpm installed')
  return { command: after, allowBuild: pnpmSupportsDangerouslyAllowAllBuilds(await pnpmVersion(after)) }
}

export function findSourceCheckout(cfg: { srcPath: string }): string | undefined {
  if (isDshCheckout(cfg.srcPath)) return cfg.srcPath
  const managed = managedSourceCheckout()
  return isDshCheckout(managed) ? managed : undefined
}

interface SourceCheckout {
  path: string
  cloned: boolean
}

export async function ensureSourceCheckout(cfg: { srcPath: string }, host: InstallHost): Promise<SourceCheckout | undefined> {
  const existing = findSourceCheckout(cfg)
  if (existing) return { path: existing, cloned: false }
  const chosen = await chooseInstallDir('source', managedSourceCheckout())
  if (!chosen) return undefined
  // Persist the default too: an explicit value pins the clone against a future default change.
  if (!(await saveDshSetting('srcPath', chosen))) {
    host.addActivity(`⚠ could not remember dsh.srcPath — using ${maskPath(chosen)} for this session; reload the window if the extension was just installed or updated`)
  }
  if (isDshCheckout(chosen)) {
    host.addActivity('✓ Existing deepseek-harness checkout found — reusing it')
    return { path: chosen, cloned: false }
  }
  try {
    if (fs.readdirSync(chosen).length > 0) {
      reportStepFailure(
        host,
        `✗ ${maskPath(chosen)} is not empty and is not a deepseek-harness checkout — pick an empty folder`,
        'DeepSeek Harness: that folder already contains files. Pick an empty folder or an existing deepseek-harness checkout.',
      )
      return undefined
    }
  } catch {
    // Unreadable or not created yet: let git report the real error.
  }
  host.setDshState('missing')
  host.addActivity('✗ No dsh source checkout found — cloning deepseek-harness…')
  host.addActivity(`▶ Cloning deepseek-harness → ${chosen}`)
  const ok = await host.runInstalling(() => host.runInTerminal('Clone deepseek-harness', 'git', ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', chosen]))
  if (!ok || !isDshCheckout(chosen)) {
    reportStepFailure(
      host,
      '✗ clone failed — see the terminal output above',
      'DeepSeek Harness: could not clone deepseek-harness. Check your network and git, then try again.',
    )
    return undefined
  }
  host.addActivity('✓ deepseek-harness cloned')
  return { path: chosen, cloned: true }
}
