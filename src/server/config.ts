/**
 * Reading and migrating the launcher's own settings (`dsh.*`).
 *
 * Settings are read fresh on every call rather than cached: `dsh.runMode` is
 * the single source of truth for which dsh a start runs, so the panel toggle
 * and the Settings UI have to agree even mid-session.
 *
 * The legacy-key fallback in {@link readConfig} and the one-time
 * {@link migrateLegacyDshConfig} exist together on purpose: migration clears
 * the dead keys out of `settings.json`, while the fallback keeps values alive
 * during the window before it runs (and on a profile where it cannot write).
 *
 * @module server/config
 */

import * as vscode from 'vscode'
import { DEFAULT_PORT, MAX_PORT, parseNpmChannel, type NpmChannel } from '../env.ts'

type RunMode = 'pnpm' | 'source'

/** Resolved extension settings (dsh.*). */
export interface DshConfig {
  runMode: RunMode
  /** Which npm dist-tag pkg mode resolves: 'latest' (stable), 'next' (rc), or 'alpha'. */
  npmChannel: NpmChannel
  srcPath: string
  /** Custom pkg install dir; empty means the launcher-managed default. */
  pkgPath: string
  nodePath: string
  port: number
  /** Print module-loading progress in source mode (NODE_DEBUG=module). */
  sourceDebug: boolean
  /** Open the browser automatically after Start (dsh.autoOpenBrowser; explicit 'New Tab' clicks always open). */
  autoOpenBrowser: boolean
}

/** 0.2.6 改名的配置键（新键 ← 旧键）。 */
const LEGACY_CONFIG_KEYS: [newKey: string, oldKey: string][] = [
  ['runMode', 'mode'],
  ['npmChannel', 'channel'],
  ['srcPath', 'path'],
]

/** Read the persisted `dsh.*` settings. */
export function readConfig(): DshConfig {
  // Read the persisted settings every time: dsh.runMode is the single source
  // of truth, so both the panel toggle and the Settings UI stay in sync.
  const c = vscode.workspace.getConfiguration('dsh')
  // Clamp the port to the valid TCP range; an out-of-range value from Settings
  // Sync or manual edits would otherwise make every probe throw.
  const port = c.get<number>('port') ?? DEFAULT_PORT
  // 旧键名（dsh.mode / dsh.channel / dsh.path）兜底读取：migrateLegacyDshConfig
  // 激活时会把旧值搬进新键并清掉旧键，这里保证迁移跑完前的短暂窗口也不丢值。
  return {
    runMode: (c.get<string>('runMode') ?? c.get<string>('mode')) === 'source' ? 'source' : 'pnpm',
    npmChannel: parseNpmChannel(c.get<string>('npmChannel') ?? c.get<string>('channel') ?? undefined),
    srcPath: c.get<string>('srcPath') ?? c.get<string>('path') ?? '',
    pkgPath: c.get<string>('pkgPath') ?? '',
    nodePath: c.get<string>('nodePath') ?? '',
    port: Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : DEFAULT_PORT,
    sourceDebug: c.get<boolean>('sourceDebug') ?? false,
    autoOpenBrowser: c.get<boolean>('autoOpenBrowser') ?? true,
  }
}

/**
 * One-time migration for the 0.2.6 key renames: when a legacy key still holds
 * a value and the new key is unset, move the value to the new key and clear
 * the old one, so settings.json does not keep dead keys. {@link readConfig}
 * still falls back to the legacy keys as a safety net (e.g. before this runs).
 */
export async function migrateLegacyDshConfig(): Promise<void> {
  const c = vscode.workspace.getConfiguration('dsh')
  for (const [newKey, oldKey] of LEGACY_CONFIG_KEYS) {
    if (c.get(newKey) !== undefined) continue
    const legacy = c.get(oldKey)
    if (legacy === undefined) continue
    await c.update(newKey, legacy, vscode.ConfigurationTarget.Global)
    await c.update(oldKey, undefined, vscode.ConfigurationTarget.Global)
  }
}

/** Persist the run mode chosen in the panel toggle. */
export function writeRunMode(mode: RunMode): Thenable<void> {
  return vscode.workspace.getConfiguration('dsh').update('runMode', mode, vscode.ConfigurationTarget.Global)
}

/**
 * Watch `dsh.*` for changes made outside the panel (Settings UI, settings sync),
 * so the caller can drop its mode-dependent caches.
 */
export function onDshConfigChanged(invalidate: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dsh')) invalidate()
  })
}
