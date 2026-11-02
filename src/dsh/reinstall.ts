import * as fs from 'node:fs'
import { installManifestRepairable, installedDshVersion, writeInstallManifest } from './paths.ts'
import type { PackageImportMethod } from '../shared/env.ts'

export interface ReinstallHost {
  addActivity: (line: string, isBusy?: boolean) => unknown
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    // Leftovers only cost disk; never let cleanup break the reinstall.
  }
}

/**
 * Rebuild the launcher-managed install in a staging folder, then swap it in.
 *
 * The live install is never mutated while pnpm runs: a failed build only removes the
 * staging folder, and the swap is a directory rename. This is the only safe way to
 * change `package-import-method`, because an in-place rebuild leaves the live install
 * half-replaced when pnpm fails and can break the profile bundles that point into it.
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
  const nextDir = `${dir}.next`
  const prevDir = `${dir}.prev`
  removeQuietly(nextDir)
  removeQuietly(prevDir)
  try {
    fs.mkdirSync(nextDir, { recursive: true })
    if (!writeInstallManifest(version, nextDir, importMethod)) {
      removeQuietly(nextDir)
      host.addActivity('✗ could not write the dsh install manifest — check write permissions')
      return false
    }
    host.addActivity(`▶ Building dsh v${version} in a staging folder (${importMethod} import)…`)
    const args = ['install', '--dir', nextDir, '--package-import-method', importMethod]
    if (allowBuild) args.push('--dangerously-allow-all-builds')
    const ok = await host.runInstalling(() => host.runInTerminal(`Rebuild dsh v${version}`, pnpmCmd, args))
    if (!ok || installedDshVersion(nextDir) !== version) {
      removeQuietly(nextDir)
      host.addActivity('✗ dsh rebuild failed — the current install was left untouched; see the terminal output above')
      return false
    }
    let previousMoved = false
    try {
      if (fs.existsSync(dir)) {
        fs.renameSync(dir, prevDir)
        previousMoved = true
      }
      fs.renameSync(nextDir, dir)
    } catch (error) {
      if (previousMoved && !fs.existsSync(dir)) {
        try {
          fs.renameSync(prevDir, dir)
        } catch {
          host.addActivity(`✗ the rebuilt install could not be switched in and the previous one could not be restored automatically — it is at ${prevDir}`)
          return false
        }
      }
      removeQuietly(nextDir)
      host.addActivity(`✗ could not switch to the rebuilt install: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    removeQuietly(prevDir)
    return true
  } catch (error) {
    removeQuietly(nextDir)
    host.addActivity(`✗ dsh rebuild failed — the current install was left untouched: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
