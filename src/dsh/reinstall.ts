import * as fs from 'node:fs'
import * as path from 'node:path'
import { installManifestRepairable, installedDshVersion, writeInstallManifest } from './paths.ts'
import type { PackageImportMethod } from '../shared/env.ts'

export interface ReinstallHost {
  addActivity: (line: string, isBusy?: boolean) => unknown
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
}

const PREV_SUFFIX = '.prev'
const NEXT_SUFFIX = '.next'
const LOCK_SUFFIX = '.launcher-lock'

/** The stale lock only guards against a crashed conversion; any real one ends far sooner. */
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
 * Converge leftovers from an interrupted conversion before anything reads the install.
 * A healthy live install wins; otherwise the previous one is restored in place.
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
    // Leave .prev in place; the next Start retries the recovery.
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
      // The lock disappeared between checks; retry once.
      return acquireLock(dir)
    }
    return undefined
  }
}

function releaseLock(lock: string | undefined): void {
  if (lock !== undefined) removeQuietly(lock)
}

function installArgs(
  dir: string,
  importMethod: PackageImportMethod,
  allowBuild: boolean,
  title: string,
  pnpmCmd: string,
  host: ReinstallHost,
): Promise<boolean> {
  const args = ['install', '--dir', dir, '--package-import-method', importMethod]
  if (allowBuild) args.push('--dangerously-allow-all-builds')
  return host.runInstalling(() => host.runInTerminal(title, pnpmCmd, args))
}

/**
 * Change the install's `package-import-method` without ever leaving a half-replaced tree.
 *
 * pnpm creates absolute junction targets on Windows, so a tree built in `package.next`
 * and renamed to `package` keeps pointing at the (now gone) staging path and cannot be
 * loaded. The build therefore has to happen at the final path:
 *
 * 1. build once in a throwaway staging folder to prove pnpm/network/arguments work;
 * 2. move the live install to `package.prev`;
 * 3. install at the final `package` path (junctions now point at the canonical path);
 * 4. verify, then delete `package.prev`; on failure restore it (its junctions point at
 *    the canonical `package` path again, so the restored install keeps working).
 *
 * A lock file stops two windows from converting the same install concurrently, and
 * leftovers from an interrupted run are converged by `recoverInterruptedReinstall`.
 */
export async function stagedReinstall(
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
    host.addActivity('⚠ another window is already rebuilding dsh — try again in a minute')
    return false
  }
  try {
    return await convertUnderLock(version, dir, pnpmCmd, allowBuild, importMethod, host)
  } finally {
    releaseLock(lock)
  }
}

async function convertUnderLock(
  version: string,
  dir: string,
  pnpmCmd: string,
  allowBuild: boolean,
  importMethod: PackageImportMethod,
  host: ReinstallHost,
): Promise<boolean> {
  const nextDir = `${dir}${NEXT_SUFFIX}`
  const prevDir = `${dir}${PREV_SUFFIX}`
  removeQuietly(nextDir)

  // 1. Preflight build: catches pnpm/network/flag problems without touching the live install.
  try {
    fs.mkdirSync(nextDir, { recursive: true })
    if (!writeInstallManifest(version, nextDir, importMethod)) {
      host.addActivity('✗ could not write the dsh install manifest — check write permissions')
      return false
    }
    host.addActivity(`▶ Verifying the dsh rebuild in a staging folder (${importMethod} import)…`)
    const stagedOk = await installArgs(nextDir, importMethod, allowBuild, `Verify dsh v${version} rebuild`, pnpmCmd, host)
    if (!stagedOk || !installLooksHealthy(nextDir)) {
      host.addActivity('✗ dsh rebuild preflight failed — the current install was left untouched; see the terminal output above')
      return false
    }
  } finally {
    removeQuietly(nextDir)
  }

  // 2. Move the live install aside; its junctions point at the canonical path.
  removeQuietly(prevDir)
  let previousMoved = false
  try {
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, prevDir)
      previousMoved = true
    }
  } catch (error) {
    host.addActivity(`✗ could not move the current dsh install aside: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }

  const restore = (): false => {
    removeQuietly(dir)
    if (previousMoved) {
      try {
        fs.renameSync(prevDir, dir)
      } catch {
        host.addActivity(`✗ the previous dsh install could not be restored automatically — it is at ${prevDir}`)
      }
    }
    return false
  }

  // 3. Install at the final path so pnpm's junctions target the canonical location.
  try {
    if (!writeInstallManifest(version, dir, importMethod)) {
      host.addActivity('✗ could not write the dsh install manifest — check write permissions')
      return restore()
    }
    host.addActivity(`▶ Reinstalling dsh v${version} (${importMethod} import)…`)
    const ok = await installArgs(dir, importMethod, allowBuild, `Reinstall dsh v${version}`, pnpmCmd, host)
    if (!ok || !installLooksHealthy(dir)) {
      host.addActivity('✗ dsh reinstall failed — the previous install was restored; see the terminal output above')
      return restore()
    }
  } catch (error) {
    host.addActivity(`✗ dsh reinstall failed — restoring the previous install: ${error instanceof Error ? error.message : String(error)}`)
    return restore()
  }

  // 4. Success: the old tree is no longer needed.
  removeQuietly(prevDir)
  return true
}
