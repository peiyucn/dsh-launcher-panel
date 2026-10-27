import * as vscode from 'vscode'
import { dbg } from '../shared/activity.ts'
import {
  DEFAULT_INSTANCE_PORT_BASE,
  DEFAULT_PORT,
  MAX_PORT,
  MIN_INSTANCE_PORT_BASE,
  parseNpmChannel,
  type NpmChannel,
} from '../shared/env.ts'

type RunMode = 'pnpm' | 'source'

export interface DshConfig {
  runMode: RunMode
  npmChannel: NpmChannel
  srcPath: string
  pkgPath: string
  nodePath: string
  port: number
  instancePortBase: number
  sourceDebug: boolean
  autoOpenBrowser: boolean
  hideConsole: boolean
  clearServerLogOnStart: boolean
  instanceBrand: boolean
}

const LEGACY_CONFIG_KEYS: [newKey: string, oldKey: string][] = [
  ['runMode', 'mode'],
  ['npmChannel', 'channel'],
  ['srcPath', 'path'],
]

export function readConfig(): DshConfig {
  const c = vscode.workspace.getConfiguration('dsh')
  // Settings Sync or manual edits can carry invalid numbers; probes would fail on them.
  const port = c.get<number>('port') ?? DEFAULT_PORT
  const portBase = c.get<number>('instancePortBase') ?? DEFAULT_INSTANCE_PORT_BASE
  // The legacy keys stay readable during the window before migrateLegacyDshConfig runs.
  return {
    runMode: (c.get<string>('runMode') ?? c.get<string>('mode')) === 'source' ? 'source' : 'pnpm',
    npmChannel: parseNpmChannel(c.get<string>('npmChannel') ?? c.get<string>('channel') ?? undefined),
    srcPath: c.get<string>('srcPath') ?? c.get<string>('path') ?? '',
    pkgPath: c.get<string>('pkgPath') ?? '',
    nodePath: c.get<string>('nodePath') ?? '',
    port: Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : DEFAULT_PORT,
    instancePortBase: Number.isInteger(portBase) && portBase >= MIN_INSTANCE_PORT_BASE && portBase <= MAX_PORT
      ? portBase
      : DEFAULT_INSTANCE_PORT_BASE,
    sourceDebug: c.get<boolean>('sourceDebug') ?? false,
    autoOpenBrowser: c.get<boolean>('autoOpenBrowser') ?? true,
    hideConsole: c.get<boolean>('hideConsole') ?? true,
    clearServerLogOnStart: c.get<boolean>('clearServerLogOnStart') ?? true,
    instanceBrand: c.get<boolean>('instanceBrand') ?? true,
  }
}

export async function migrateLegacyDshConfig(): Promise<void> {
  const c = vscode.workspace.getConfiguration('dsh')
  for (const [newKey, oldKey] of LEGACY_CONFIG_KEYS) {
    if (c.get(newKey) !== undefined) continue
    const legacy = c.get(oldKey)
    if (legacy === undefined) continue
    try {
      await c.update(newKey, legacy, vscode.ConfigurationTarget.Global)
      await c.update(oldKey, undefined, vscode.ConfigurationTarget.Global)
    } catch (error) {
      // Activation has no caller to handle a rejection; readConfig still falls back to the old key.
      dbg(`legacy dsh setting "${oldKey}" not migrated: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function writeRunMode(mode: RunMode): Thenable<void> {
  return vscode.workspace.getConfiguration('dsh').update('runMode', mode, vscode.ConfigurationTarget.Global)
}
