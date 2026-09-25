/**
 * Working out which dsh is on this machine.
 *
 * Two questions get answered here and they are deliberately separate:
 *
 * - **Which version** — for the panel's version row. Source mode reads it from
 *   git (`git describe`) rather than from the checkout's manifest, because the
 *   manifest's version only changes when upstream cuts a release: showing that
 *   number for a checkout that has moved past its tag would be a lie. Off a
 *   tag, `describe` reports `tag-N-gsha`, which is honest.
 * - **Whether it is usable** — a state plus the path to show, where `unknown`
 *   means "the install has begun but is not finished", not "broken".
 *
 * @module server/detect
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { GIT_OP_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'
import { dshVersionFromDescribe } from '../versions.ts'
import { findPnpm } from '../pnpm.ts'
import { managedSourceCheckout, pkgInstallDir, pkgInstalledVersion } from './install.ts'

/** Availability of one detected component, for the panel's status row. */
export type ConditionState = 'unknown' | 'ok' | 'missing'

/** What one dsh detection pass found. */
export interface DshDetection {
  state: ConditionState
  path: string
}

/** The settings a detection pass needs. */
export interface DetectConfig {
  runMode: 'pnpm' | 'source'
  srcPath: string
  pkgPath: string
}

/** What detection needs from the lifecycle it runs inside. */
export interface DetectHost {
  /** The source checkout to inspect, when one exists. */
  findSourceCheckout: (cfg: DetectConfig) => string | undefined
  /** Record the detected version ('' when unknown). */
  setDshVersion: (version: string) => void
}

/** Detect the local dsh version: a source checkout (source mode), else the managed install. */
export async function detectDshVersion(cfg: DetectConfig, host: DetectHost): Promise<void> {
  if (cfg.runMode === 'source') {
    const checkout = host.findSourceCheckout(cfg)
    if (!checkout) {
      // No checkout configured: dsh is 'missing', so drop any stale version.
      host.setDshVersion('')
      return
    }
    // git describe 是唯一诚实的版本来源：在 tag 上显示 tag，不在 tag 上显示
    // tag-N-gsha（官方 master 的 manifest 版本号只在切割时变，显示它会撒谎）。
    // 值按 pkg 模式的写法规整（去掉 tag 的 dsh- 前缀），面板与版本比较共用一种写法。
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
  // pkg mode: only the pkg install counts (Start reinstalls from the registry on demand).
  host.setDshVersion(pkgInstalledVersion(cfg) ?? '')
}

/** Detect dsh: source mode uses a checkout; pkg uses the managed pnpm install. */
export async function detectDsh(cfg: DetectConfig, host: DetectHost): Promise<DshDetection> {
  if (cfg.runMode === 'source') {
    const checkout = host.findSourceCheckout(cfg)
    if (checkout) return { state: 'ok', path: checkout }
    // Not cloned yet; show the chosen path only once the clone has started
    // (the dir appears as soon as the user picks a location).
    const chosen = cfg.srcPath && cfg.srcPath.trim() !== '' ? cfg.srcPath : managedSourceCheckout()
    return fs.existsSync(chosen)
      ? { state: 'unknown', path: chosen }
      : { state: 'unknown', path: '' }
  }
  if (!(await findPnpm())) return { state: 'missing', path: '' }
  const dir = pkgInstallDir(cfg)
  // 'ok' once installed; show the path as soon as it exists (install started).
  if (pkgInstalledVersion(cfg) !== undefined) return { state: 'ok', path: dir }
  return fs.existsSync(dir)
    ? { state: 'unknown', path: dir }
    : { state: 'unknown', path: '' }
}
