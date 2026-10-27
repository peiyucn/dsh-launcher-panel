import * as fs from 'node:fs'
import * as path from 'node:path'
import { GIT_OP_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'
import { dshVersionFromDescribe } from '../versions.ts'
import { findPnpm } from '../pnpm.ts'
import { managedSourceCheckout, pkgInstallDir, pkgInstalledVersion } from './install.ts'

type ConditionState = 'unknown' | 'ok' | 'missing'

interface DshDetection {
  state: ConditionState
  path: string
}

interface DetectConfig {
  runMode: 'pnpm' | 'source'
  srcPath: string
  pkgPath: string
}

export interface DetectHost {
  findSourceCheckout: (cfg: DetectConfig) => string | undefined
  setDshVersion: (version: string) => void
}

export async function detectDshVersion(cfg: DetectConfig, host: DetectHost): Promise<void> {
  if (cfg.runMode === 'source') {
    const checkout = host.findSourceCheckout(cfg)
    if (!checkout) {
      host.setDshVersion('')
      return
    }
    // git describe stays honest off a tag (tag-N-gsha); the checkout manifest only changes on release.
    const described = await runFile('git', ['-C', checkout, 'describe', '--tags', '--always'], GIT_OP_TIMEOUT_MS)
    if (described.ok && described.stdout.trim() !== '') {
      host.setDshVersion(dshVersionFromDescribe(described.stdout))
      return
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'apps', 'cli', 'package.json'), 'utf8')) as { version?: string }
      host.setDshVersion(pkg?.version ?? '')
    } catch {
      host.setDshVersion('')
    }
    return
  }
  // pkg mode: only the managed install counts; Start installs from the registry on demand.
  host.setDshVersion(pkgInstalledVersion(cfg) ?? '')
}

export async function detectDsh(cfg: DetectConfig, host: DetectHost): Promise<DshDetection> {
  if (cfg.runMode === 'source') {
    const checkout = host.findSourceCheckout(cfg)
    if (checkout) return { state: 'ok', path: checkout }
    // Show the chosen path once it exists — that is how a clone in progress becomes visible.
    const chosen = cfg.srcPath.trim() !== '' ? cfg.srcPath : managedSourceCheckout()
    return { state: 'unknown', path: fs.existsSync(chosen) ? chosen : '' }
  }
  if (!(await findPnpm())) return { state: 'missing', path: '' }
  const dir = pkgInstallDir(cfg)
  if (pkgInstalledVersion(cfg) !== undefined) return { state: 'ok', path: dir }
  return { state: 'unknown', path: fs.existsSync(dir) ? dir : '' }
}
