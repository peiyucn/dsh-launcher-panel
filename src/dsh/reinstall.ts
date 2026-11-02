import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PackageImportMethod } from '../shared/env.ts'
import { installManifestRepairable, installedDshVersion, writeInstallManifest } from './paths.ts'

/** Sibling files/dirs pnpm would otherwise reuse and carry stale resolution into a reinstall. */
const BACKUP_NAMES = ['node_modules', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json'] as const

const BACKUP_SUFFIX = '.launcher-backup'

export interface CleanReinstallHost {
  addActivity: (line: string, isBusy?: boolean) => unknown
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
}

/**
 * Rebuild the launcher-managed install from just the generated manifest.
 *
 * `pnpm install --force --package-import-method …` re-imports every file but keeps the
 * old lockfile/workspace state, which can drag unrelated (for example cross-platform)
 * packages into the install. Moving that state aside makes the reinstall behave exactly
 * like a fresh install. On failure the previous state is restored so Start can continue.
 */
export async function cleanReinstall(
  version: string,
  dir: string,
  pnpmCmd: string,
  allowBuild: boolean,
  importMethod: PackageImportMethod,
  host: CleanReinstallHost,
): Promise<boolean> {
  if (!installManifestRepairable(dir)) {
    host.addActivity('⚠ keeping the existing install: its package.json is not launcher-owned')
    return false
  }
  const moved: [from: string, to: string][] = []
  const restore = (): void => {
    for (const [from, to] of [...moved].reverse()) {
      try {
        fs.rmSync(from, { recursive: true, force: true })
        fs.renameSync(to, from)
      } catch {
        // Best effort: the next Start will retry the install.
      }
    }
  }
  try {
    for (const name of BACKUP_NAMES) {
      const from = path.join(dir, name)
      if (!fs.existsSync(from)) continue
      const to = `${from}${BACKUP_SUFFIX}`
      fs.rmSync(to, { recursive: true, force: true })
      fs.renameSync(from, to)
      moved.push([from, to])
    }
  } catch (error) {
    restore()
    host.addActivity(`⚠ could not move the old dsh install aside: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (!writeInstallManifest(version, dir, importMethod)) {
    restore()
    host.addActivity('✗ could not write the dsh install manifest — check write permissions')
    return false
  }
  host.addActivity(`▶ Reinstalling dsh v${version} from scratch (${importMethod} import)…`)
  const args = ['install', '--dir', dir, '--package-import-method', importMethod]
  if (allowBuild) args.push('--dangerously-allow-all-builds')
  const ok = await host.runInstalling(() => host.runInTerminal(`Reinstall dsh v${version}`, pnpmCmd, args))
  if (ok && installedDshVersion(dir) === version) {
    for (const [, to] of moved) {
      try {
        fs.rmSync(to, { recursive: true, force: true })
      } catch {
        // Leftovers only cost disk; the new install is already valid.
      }
    }
    return true
  }
  restore()
  host.addActivity('✗ dsh reinstall failed — the previous install was restored; see the terminal output above')
  return false
}
