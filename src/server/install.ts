/**
 * Getting dsh itself onto this machine: locating an install, installing it with
 * pnpm, and cloning a source checkout.
 *
 * Two modes are served here and they are deliberately symmetric — `package`
 * (the published npm package, installed with pnpm) and `source` (a git clone
 * built locally) — which is why their directories are named `package` and
 * `source` side by side under the launcher's base dir.
 *
 * Anything that touches the running server's state (the version shown in the
 * panel, the "starting" phase, the terminal a setup runs in) is passed in as a
 * dependency rather than reached for, so this module stays testable and the
 * lifecycle stays in server.ts.
 *
 * @module server/install
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { dshBaseDir, installManifestRepairable, installedDshVersion, isDshCheckout, isDshInstallDirUsable, maskPath, writeInstallManifest } from '../paths.ts'
import { npmSpecForChannel, type NpmChannel } from '../env.ts'
import { PNPM_PROBE_TIMEOUT_MS, PNPM_VIEW_TIMEOUT_MS } from '../timing.ts'
import { runResolved } from '../proc.ts'
import { findPnpm, pnpmSupportsDangerouslyAllowAllBuilds } from '../pnpm.ts'

/**
 * What the install layer needs from the lifecycle it runs inside.
 *
 * Passing these in keeps the direction of dependency one-way: the install code
 * never imports server.ts, so server.ts stays the only module that owns the
 * server's state.
 */
export interface InstallHost {
  /** Report progress/failure into the panel feed; returns the entry id. */
  addActivity: (line: string, isBusy?: boolean) => number
  /**
   * Run `task` behind a spinner, clearing it whether the task succeeds or
   * throws. Preferred over pairing addActivity(…, true) with finishBusy: a
   * throw between the two leaves the spinner turning for the session.
   */
  withBusy: <T>(label: string, task: () => Promise<T>) => Promise<T>
  /** Run a long command in a visible terminal (setup/install steps). */
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  /** Wrap a step so the panel shows the `installing` phase for its duration. */
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
  /** The version the panel should report as about to run. */
  setDshVersion: (version: string) => void
  /** dsh availability, for the status line. */
  setDshState: (state: 'unknown' | 'ok' | 'missing') => void
  /** Whether the start flow is still active (a Stop may have intervened). */
  isStarting: () => boolean
  /** Diagnostic line to the log file only. */
  dbg: (line: string) => void
}

/** The launcher's default dsh package dir for pkg mode. */
export function managedPackageDir(): string {
  return path.join(dshBaseDir(), 'package')
}

/** The launcher's managed source checkout dir (where dsh is cloned for source mode). */
export function managedSourceCheckout(): string {
  return path.join(dshBaseDir(), 'source')
}

/** The pkg package dir: the user's dsh.pkgPath when set, else the managed default. */
export function pkgInstallDir(cfg: { pkgPath: string }): string {
  return cfg.pkgPath && cfg.pkgPath.trim() !== '' ? cfg.pkgPath : managedPackageDir()
}

/** The installed @deepseek-ai/dsh version for the current pkg install dir. */
export function pkgInstalledVersion(cfg: { pkgPath: string }): string | undefined {
  return installedDshVersion(pkgInstallDir(cfg))
}

/** Ask where to install dsh when nothing is installed yet: default or a custom folder. */
export async function chooseInstallDir(kind: 'pkg' | 'source', defaultDir: string): Promise<string | undefined> {
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
export async function saveDshSetting(key: 'srcPath' | 'pkgPath', value: string): Promise<void> {
  const c = vscode.workspace.getConfiguration('dsh')
  if ((c.get<string>(key) ?? '') !== value) {
    await c.update(key, value, vscode.ConfigurationTarget.Global)
  }
}

/**
 * Resolve the published @deepseek-ai/dsh version for a channel. The failure
 * carries its reason (`pnpm view` stderr / a timeout) so the panel can say why
 * instead of a blanket "could not resolve the latest dsh version".
 *
 * ⚠️ When `pnpmCmd` is omitted the command is resolved here rather than
 * defaulting to the bare name `pnpm`: on Windows that name cannot be spawned
 * (`ENOENT` — Node does not expand PATHEXT) and would silently report every
 * update check as failed. See `pickPnpmFromPath`.
 */
export async function latestDshVersion(
  channel: NpmChannel,
  dbg: (line: string) => void,
  pnpmCmd?: string,
): Promise<{ version: string } | { error: string }> {
  const spec = npmSpecForChannel(channel)
  const command = pnpmCmd ?? await findPnpm()
  if (command === undefined) return { error: 'pnpm was not found on PATH' }
  const result = await runResolved(command, ['view', spec, 'version'], PNPM_VIEW_TIMEOUT_MS)
  if (!result.ok) {
    // Keep the failure visible for diagnosis: registry outages and cmd
    // quoting problems both surface here as "unreachable" to the user.
    const error = result.error ?? `could not resolve ${spec}`
    dbg(`pnpm view failed: ${error}`)
    return { error }
  }
  const version = result.stdout.trim().split(/\r?\n/).pop()?.trim()
  return version ? { version } : { error: `the registry returned no version for ${spec}` }
}

/**
 * Install @deepseek-ai/dsh@<version> into the managed dir: write the pinned
 * manifest and run `pnpm install`, approving build scripts non-interactively
 * on pnpm ≥ 10.16 (the same thing npm does on every install).
 * @returns true once the requested version is present.
 */
export async function ensureDshInstalled(
  version: string, pnpmCmd: string, allowBuild: boolean, dir: string, host: InstallHost,
): Promise<boolean> {
  // Two independent reasons to refuse, and they need different advice:
  //  - the folder holds something the launcher must not overwrite, or
  //  - it is ours but the write failed (permissions).
  if (!isDshInstallDirUsable(dir)) {
    host.addActivity(`✗ ${maskPath(dir)} is not empty — install into an empty or dedicated folder instead`)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${maskPath(dir)} is not empty. Choose an empty or dedicated folder for the dsh install.`)
    return false
  }
  // `writeInstallManifest` re-checks ownership of an existing package.json: a
  // folder can be "usable" (it already contains a dsh install, which is what
  // pkgPath normally points at) while still holding the *user's* manifest. Never
  // replace that — the install itself does not need the manifest rewritten.
  if (!installManifestRepairable(dir)) {
    host.addActivity(`ℹ ${maskPath(dir)} already contains a dsh install with its own package.json — leaving that file untouched`)
  } else if (!writeInstallManifest(version, dir)) {
    host.addActivity('✗ could not write the dsh install manifest — check write permissions')
    return false
  }
  // The phase is already 'starting' (set at the top of ensureRunningUnlocked).
  host.addActivity(`▶ Installing dsh v${version} (pnpm install)…`)
  const args = ['install', '--dir', dir]
  if (allowBuild) args.push('--dangerously-allow-all-builds')
  const ok = await host.runInstalling(() => host.runInTerminal(`Install dsh v${version}`, pnpmCmd, args))
  if (!ok || installedDshVersion(dir) !== version) {
    if (host.isStarting()) {
      host.addActivity('✗ dsh install failed — see the terminal output above')
      void vscode.window.showErrorMessage('DeepSeek Harness: dsh install failed. Check the terminal output.')
    }
    return false
  }
  return true
}

/**
 * Prepare the pkg start: the installed version IS the version that runs — the
 * channel (dsh.npmChannel) only decides what to install on first run and what
 * the Update button targets; Start never upgrades or downgrades an installed
 * dsh. Only when nothing is installed does Start resolve the channel version,
 * install it, and run it.
 *
 * @returns the version to run, or undefined to abort.
 */
export async function preparePkgStart(
  cfg: { pkgPath: string; npmChannel: NpmChannel }, pnpmCmd: string, allowBuild: boolean, host: InstallHost,
): Promise<string | undefined> {
  const dir = pkgInstallDir(cfg)
  const installed = installedDshVersion(dir)
  if (installed !== undefined) {
    // 已装即所跑：不查注册表（离线可启动）、不随通道切换重装/降级。
    // 顺手修复历史残局（失败的安装尝试可能留下 manifest 与已装版本不一致的状态）——
    // writeInstallManifest 内部已确认 manifest 归属，所以 pkgPath 指向用户项目时
    // 不会覆盖人家的 manifest。写失败不阻断启动（spawnPkg 已禁用
    // verify-deps-before-run，pnpm 不会自动重装）。
    if (!writeInstallManifest(installed, dir)) {
      host.dbg('install manifest not rewritten (absent ownership or write failure); continuing with the installed dsh')
    }
    host.setDshVersion(installed)
    return installed
  }
  // 首次安装：解析通道版本 → 选安装目录 → 安装。注册表查询可能耗时数秒，
  // 展示进度避免慢网络下看起来像 Start 卡死。
  const resolved = await host.withBusy('ℹ Resolving the dsh channel version…', () => latestDshVersion(cfg.npmChannel, host.dbg, pnpmCmd))
  if ('error' in resolved) {
    host.setDshState('missing')
    host.addActivity(`✗ dsh is not installed and the registry is unreachable (${resolved.error}) — check your network and try again`)
    void vscode.window.showErrorMessage('DeepSeek Harness: unable to reach the registry to install dsh. Check your network connection.')
    return undefined
  }
  const version = resolved.version
  // A custom dsh.pkgPath wins; on a first install with no custom path, let the
  // user choose the default or a custom folder.
  let installDir = dir
  if (!cfg.pkgPath) {
    const chosen = await chooseInstallDir('pkg', managedPackageDir())
    if (!chosen) return undefined
    // Persist the user's choice even when it is the managed default: the
    // setting then shows the actual install path and pins it against future
    // default-location changes.
    await saveDshSetting('pkgPath', chosen)
    installDir = chosen
  }
  host.addActivity(`ℹ dsh v${version} — installing it now (first run, can take a few minutes)`)
  // The panel shows the version that is about to run (buildWebArgs also reads
  // this to decide --no-open).
  host.setDshVersion(version)
  if (!(await ensureDshInstalled(version, pnpmCmd, allowBuild, installDir, host))) return undefined
  return version
}

/** The pnpm version string ('' on failure). */
export async function pnpmVersion(pnpmCmd: string): Promise<string> {
  const result = await runResolved(pnpmCmd, ['--version'], PNPM_PROBE_TIMEOUT_MS)
  return result.ok ? result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '' : ''
}

/**
 * Make sure pnpm is available in pnpm mode: resolve it on PATH (or the known
 * Windows shim locations), and install it via npm when missing. There is no
 * prompt — without pnpm the start cannot proceed, so the console announces
 * the reason and the install begins immediately.
 *
 * @returns the resolved command and whether install accepts
 *   `--dangerously-allow-all-builds`, or undefined when the start must abort.
 */
export async function ensurePnpmAvailable(host: InstallHost): Promise<{ command: string; allowBuild: boolean } | undefined> {
  const found = await findPnpm()
  if (found) return { command: found, allowBuild: pnpmSupportsDangerouslyAllowAllBuilds(await pnpmVersion(found)) }
  host.setDshState('missing')
  host.addActivity('✗ pnpm not found — installing it now (npm install -g pnpm)')
  // The phase is already 'starting' (set at the top of ensureRunningUnlocked).
  host.addActivity('▶ Installing pnpm (npm install -g pnpm)…')
  const ok = await host.runInstalling(() => host.runInTerminal('Install pnpm', 'npm', ['install', '-g', 'pnpm']))
  if (!ok) {
    if (host.isStarting()) {
      host.addActivity('✗ pnpm install failed — run `npm install -g pnpm` in a terminal, then try again')
      void vscode.window.showErrorMessage('DeepSeek Harness: pnpm install failed. Run "npm install -g pnpm" in a terminal, then try again.')
    }
    return undefined
  }
  const after = await findPnpm()
  if (!after) {
    host.addActivity('✗ pnpm installed but not on PATH — restart VS Code, then try again')
    void vscode.window.showErrorMessage('DeepSeek Harness: pnpm was installed but is not on PATH yet. Restart VS Code, then try again.')
    return undefined
  }
  host.setDshState('unknown')
  host.addActivity('✓ pnpm installed')
  return { command: after, allowBuild: pnpmSupportsDangerouslyAllowAllBuilds(await pnpmVersion(after)) }
}

/**
 * Locate the source checkout: the explicit `dsh.srcPath` setting when it is a
 * valid checkout, else the launcher's managed clone.
 */
export function findSourceCheckout(cfg: { srcPath: string }): string | undefined {
  if (isDshCheckout(cfg.srcPath)) return cfg.srcPath
  const managed = managedSourceCheckout()
  return isDshCheckout(managed) ? managed : undefined
}

/** A source checkout resolved for a start: its path, and whether this start cloned it. */
export interface SourceCheckout {
  path: string
  /** This start cloned the checkout (first install), so setup should follow without asking. */
  cloned: boolean
}

/** Make sure a source checkout exists: reuse one, or clone deepseek-harness into the managed dir. */
export async function ensureSourceCheckout(cfg: { srcPath: string }, host: InstallHost): Promise<SourceCheckout | undefined> {
  const existing = findSourceCheckout(cfg)
  if (existing) return { path: existing, cloned: false }
  // Nothing cloned yet: let the user pick the default or a custom location.
  const chosen = await chooseInstallDir('source', managedSourceCheckout())
  if (!chosen) return undefined
  // Persist the choice even when it is the managed default: the setting then
  // shows the actual clone path and pins it against future default changes.
  await saveDshSetting('srcPath', chosen)
  // The picked folder may already be a checkout (e.g. the user pointed at
  // their own clone): reuse it instead of cloning into it, which git would
  // refuse for a non-empty folder anyway.
  if (isDshCheckout(chosen)) {
    host.addActivity('✓ Existing deepseek-harness checkout found — reusing it')
    return { path: chosen, cloned: false }
  }
  try {
    if (fs.readdirSync(chosen).length > 0) {
      host.addActivity(`✗ ${maskPath(chosen)} is not empty and is not a deepseek-harness checkout — pick an empty folder`)
      void vscode.window.showErrorMessage('DeepSeek Harness: that folder already contains files. Pick an empty folder or an existing deepseek-harness checkout.')
      return undefined
    }
  } catch {
    // Unreadable or not created yet: let the clone attempt surface the error.
  }
  host.setDshState('missing')
  host.addActivity('✗ No dsh source checkout found — cloning deepseek-harness…')
  host.addActivity(`▶ Cloning deepseek-harness → ${chosen}`)
  const ok = await host.runInstalling(() => host.runInTerminal('Clone deepseek-harness', 'git', ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', chosen]))
  if (!ok || !isDshCheckout(chosen)) {
    // Suppress the failure report when Stop interrupted the clone: the user
    // asked for it, so the terminal error is noise, not news.
    if (host.isStarting()) {
      host.addActivity('✗ clone failed — see the terminal output above')
      void vscode.window.showErrorMessage('DeepSeek Harness: could not clone deepseek-harness. Check your network and git, then try again.')
    }
    return undefined
  }
  host.addActivity('✓ deepseek-harness cloned')
  return { path: chosen, cloned: true }
}
