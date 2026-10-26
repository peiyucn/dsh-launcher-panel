/**
 * Persistence and first-run bootstrap for multi-instance settings.
 *
 * `dsh.instances` and `dsh.activeInstance` are machine-scoped settings; this
 * module is the only place that reads or writes them, so the pure normalization
 * in `instances.ts` stays free of VS Code APIs. The bootstrap decision itself
 * lives in `instance-bootstrap.ts`, also vscode-free, so it can be tested.
 *
 * @module server/instance-store
 */

import * as os from 'node:os'
import * as vscode from 'vscode'
import { bootstrapInstances, type InstanceBootstrapHost } from '../instance-bootstrap.ts'
import {
  normalizeInstances,
  type DshInstance,
  type InstanceModelOptions,
  type NormalizedInstances,
} from '../instances.ts'
import { dshBaseDir, resolveDshHome } from '../paths.ts'
import { managedPackageDir, managedSourceCheckout } from './install.ts'

/**
 * globalState key marking the instance list as authoritative.
 *
 * The string is kept from the original one-time migration so existing installs
 * keep their intent: a user who deleted every instance must not get a
 * synthesized Default resurrected. It is now written only after the list was
 * actually persisted (or emptied on purpose) rather than before.
 */
const LIST_AUTHORITATIVE_KEY = 'dsh.instancesMigrated'

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

/** Write the synthesized list and remember that it is authoritative. */
async function persistInitialInstances(
  context: Pick<vscode.ExtensionContext, 'globalState'>,
  instances: readonly DshInstance[],
  activeId: string,
): Promise<void> {
  await writeInstances(instances)
  await writeActiveInstance(activeId)
  try {
    await context.globalState.update(LIST_AUTHORITATIVE_KEY, true)
  } catch {
    // The list is saved; a lost marker only means the Default is synthesized
    // once more on a later start, which is harmless.
  }
}

/**
 * Read the list a session starts from.
 *
 * A fresh machine has neither dsh nor `~/.dsh`; the synthesized Default
 * instance deliberately only records coordinates. Its home/profile are created
 * by DSH on the first Start. Persisting that instance is best-effort: see
 * `instance-bootstrap.ts` for why a failed settings write must not cost the
 * session its only instance.
 */
export async function readInitialInstances(
  context: Pick<vscode.ExtensionContext, 'globalState'>,
): Promise<NormalizedInstances> {
  const host: InstanceBootstrapHost = {
    readPersisted: () => {
      const cfg = vscode.workspace.getConfiguration('dsh')
      return {
        instances: cfg.get<unknown>('instances'),
        activeId: cfg.get<string>('activeInstance'),
        legacyPort: cfg.get<number>('port'),
      }
    },
    isListAuthoritative: () => context.globalState.get<boolean>(LIST_AUTHORITATIVE_KEY) === true,
    persist: (instances, activeId) => persistInitialInstances(context, instances, activeId),
    markAuthoritative: () => Promise.resolve(context.globalState.update(LIST_AUTHORITATIVE_KEY, true)),
  }
  return bootstrapInstances(host, instanceModelOptions())
}

/** Remember that the user-managed instance list is authoritative; best effort. */
export async function markInstancesAuthoritative(
  context: Pick<vscode.ExtensionContext, 'globalState'>,
): Promise<void> {
  try {
    await context.globalState.update(LIST_AUTHORITATIVE_KEY, true)
  } catch {
    // Best effort: only affects whether an empty list is re-synthesized.
  }
}
