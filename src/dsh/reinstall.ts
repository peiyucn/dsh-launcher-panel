import * as fs from 'node:fs'
import * as path from 'node:path'
import { installManifestRepairable, installedDshVersion, maskPath, writeInstallManifest } from './paths.ts'
import type { PackageImportMethod } from '../shared/env.ts'

export interface ReinstallHost {
  addActivity: (line: string, isBusy?: boolean) => unknown
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
}

const PREV_SUFFIX = '.prev'
const NEXT_SUFFIX = '.next'
const LOCK_SUFFIX = '.launcher-lock'

/** The stale lock only guards against a crashed reinstall; any real one ends far sooner. */
const LOCK_STALE_MS = 30 * 60_000

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    // Leftovers only cost disk; never let cleanup break the reinstall.
  }
}

/** Version readable AND the CLI entry present: a partially installed tree is not healthy. */
export function installLooksHealthy(dir: string): boolean {
  if (installedDshVersion(dir) === undefined) return false
  return fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
}

/**
 * Clean state left by older launcher versions that renamed install folders around.
 * The current scheme never renames anything, but a crash from an old version may have
 * left `.prev`/`.next` behind; converge them instead of asking the user to clean up.
 */
export function recoverInterruptedReinstall(dir: string): void {
  removeQuietly(`${dir}${NEXT_SUFFIX}`)
  const prev = `${dir}${PREV_SUFFIX}`
  if (!fs.existsSync(prev)) return
  if (installLooksHealthy(dir)) {
    removeQuietly(prev)
    return
  }
  removeQuietly(dir)
  try {
    fs.renameSync(prev, dir)
  } catch {
    // Leave .prev in place; deleting the folder and starting again also recovers.
  }
}

function acquireLock(dir: string): string | undefined {
  const lock = `${dir}${LOCK_SUFFIX}`
  try {
    const fd = fs.openSync(lock, 'wx')
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return lock
  } catch {
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true })
        return acquireLock(dir)
      }
    } catch {
      return acquireLock(dir)
    }
    return undefined
  }
}

/**
 * Reinstall the same dsh version in place with the configured import method.
 *
 * Deliberately simple: `pnpm install --force` re-imports the files in the existing
 * folder. Copying the tree into a staging folder or renaming install directories was
 * fragile on Windows (absolute pnpm junctions break as soon as a tree is moved) and
 * turned a failed install into an unbootable one. The trade-off is that the install is
 * unusable while the terminal runs, so the caller must not close it; if the install
 * fails, the documented recovery is to delete the install folder and Start again.
 */
export async function reinstallInPlace(
  version: string,
  dir: string,
  pnpmCmd: string,
  allowBuild: boolean,
  importMethod: PackageImportMethod,
  host: ReinstallHost,
): Promise<boolean> {
  if (!installManifestRepairable(dir)) {
    host.addActivity('⚠ keeping the existing install: its package.json is not launcher-owned')
    return false
  }
  recoverInterruptedReinstall(dir)
  const lock = acquireLock(dir)
  if (lock === undefined) {
    host.addActivity('⚠ another window is already reinstalling dsh — try again in a minute')
    return false
  }
  try {
    if (!writeInstallManifest(version, dir, importMethod)) {
      host.addActivity('✗ could not write the dsh install manifest — check write permissions')
      return false
    }
    // A stale workspace file can change pnpm's resolution (and pulled unrelated
    // cross-platform packages into the install before). Keep it aside, drop on success.
    const workspaceFile = path.join(dir, 'pnpm-workspace.yaml')
    const workspaceBackup = `${workspaceFile}${PREV_SUFFIX}`
    let workspaceMoved = false
    if (fs.existsSync(workspaceFile)) {
      try {
        removeQuietly(workspaceBackup)
        fs.renameSync(workspaceFile, workspaceBackup)
        workspaceMoved = true
      } catch {
        host.addActivity('⚠ could not move a stale pnpm-workspace.yaml aside — the reinstall may keep old resolution')
      }
    }
    host.addActivity(`▶ Reinstalling dsh v${version} (${importMethod} import) — keep this terminal open until it finishes…`)
    const args = ['install', '--dir', dir, '--package-import-method', importMethod, '--force']
    if (allowBuild) args.push('--dangerously-allow-all-builds')
    const ok = await host.runInstalling(() => host.runInTerminal(`Reinstall dsh v${version} (do not close this terminal)`, pnpmCmd, args))
    if (ok && installLooksHealthy(dir) && installedDshVersion(dir) === version) {
      if (workspaceMoved) removeQuietly(workspaceBackup)
      return true
    }
    if (workspaceMoved) {
      try {
        fs.renameSync(workspaceBackup, workspaceFile)
      } catch {
        // The recovery instruction below covers a broken install anyway.
      }
    }
    host.addActivity(
      `✗ dsh reinstall failed — if dsh does not start afterwards: Stop all instances, delete ${maskPath(dir)}, then Start again for a clean install. See the terminal output above.`,
    )
    return false
  } finally {
    removeQuietly(lock)
  }
}
