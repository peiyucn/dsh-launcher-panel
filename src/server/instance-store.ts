/**
 * Persistence and first-run migration for multi-instance settings.
 *
 * `dsh.instances` and `dsh.activeInstance` are machine-scoped settings; this
 * module is the only place that reads or writes them, so the pure normalization
 * in `instances.ts` stays free of VS Code APIs.
 *
 * @module server/instance-store
 */

import * as os from 'node:os'
import * as vscode from 'vscode'
import {
  migrateLegacyInstance,
  normalizeInstances,
  type DshInstance,
  type InstanceModelOptions,
  type NormalizedInstances,
} from '../instances.ts'
import { dshBaseDir, resolveDshHome } from '../paths.ts'
import { managedPackageDir, managedSourceCheckout } from './install.ts'

/** globalState key guarding the one-time legacy migration. */
const MIGRATION_KEY = 'dsh.instancesMigrated'

/** The machine paths the instance model must reject or resolve against. */
export function instanceModelOptions(): InstanceModelOptions {
  return {
    homeDir: os.homedir(),
    defaultHome: resolveDshHome(),
    forbiddenHomes: [dshBaseDir(), managedPackageDir(), managedSourceCheckout()],
  }
}

/** Read the persisted instance list and active id, normalized and validated. */
export function readInstanceSettings(): NormalizedInstances {
  const cfg = vscode.workspace.getConfiguration('dsh')
  return normalizeInstances(cfg.get<unknown>('instances'), cfg.get<string>('activeInstance'), instanceModelOptions())
}

/** Persist the instance list. */
export function writeInstances(instances: readonly DshInstance[]): Thenable<void> {
  return vscode.workspace.getConfiguration('dsh').update('instances', instances, vscode.ConfigurationTarget.Global)
}

/** Persist the active instance id. */
export function writeActiveInstance(id: string): Thenable<void> {
  return vscode.workspace.getConfiguration('dsh').update('activeInstance', id, vscode.ConfigurationTarget.Global)
}

/**
 * One-time migration from the legacy single-instance `dsh.port`.
 *
 * A fresh machine has neither dsh nor `~/.dsh`; the migrated Default instance
 * deliberately only records coordinates. Its home/profile are created by DSH
 * on the first Start.
 */
export async function migrateLegacyInstances(
  context: Pick<vscode.ExtensionContext, 'globalState'>,
): Promise<NormalizedInstances> {
  const current = readInstanceSettings()
  if (context.globalState.get<boolean>(MIGRATION_KEY) === true) return current
  if (current.instances.length > 0) {
    await context.globalState.update(MIGRATION_KEY, true)
    return current
  }

  const legacyPort = vscode.workspace.getConfiguration('dsh').get<number>('port')
  const instance = migrateLegacyInstance(legacyPort)
  await writeInstances([instance])
  await writeActiveInstance(instance.id)
  await context.globalState.update(MIGRATION_KEY, true)
  return normalizeInstances([instance], instance.id, instanceModelOptions())
}
