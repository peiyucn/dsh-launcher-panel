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

/** Shares the migration marker: an emptied list must not resurrect a Default. */
const LIST_AUTHORITATIVE_KEY = 'dsh.instancesMigrated'

function dshConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dsh')
}

export function instanceModelOptions(): InstanceModelOptions {
  return {
    homeDir: os.homedir(),
    defaultHome: resolveDshHome(),
    forbiddenHomes: [dshBaseDir(), managedPackageDir(), managedSourceCheckout()],
  }
}

function rawSettings(): { instances: unknown; activeId: unknown; legacyPort: unknown } {
  const cfg = dshConfig()
  return {
    instances: cfg.get<unknown>('instances'),
    activeId: cfg.get<string>('activeInstance'),
    legacyPort: cfg.get<number>('port'),
  }
}

export function readInstanceSettings(): NormalizedInstances {
  const raw = rawSettings()
  return normalizeInstances(raw.instances, raw.activeId, instanceModelOptions())
}

export function writeInstances(instances: readonly DshInstance[]): Thenable<void> {
  return dshConfig().update('instances', instances, vscode.ConfigurationTarget.Global)
}

export function writeActiveInstance(id: string): Thenable<void> {
  return dshConfig().update('activeInstance', id, vscode.ConfigurationTarget.Global)
}

/** Best effort: a lost marker only re-synthesizes a Default once. */
async function writeAuthoritativeMarker(context: Pick<vscode.ExtensionContext, 'globalState'>): Promise<void> {
  try {
    await context.globalState.update(LIST_AUTHORITATIVE_KEY, true)
  } catch {
    // Ignored: the list itself is what matters.
  }
}

async function persistInitialInstances(
  context: Pick<vscode.ExtensionContext, 'globalState'>,
  instances: readonly DshInstance[],
  activeId: string,
): Promise<void> {
  await writeInstances(instances)
  await writeActiveInstance(activeId)
  await writeAuthoritativeMarker(context)
}

export async function readInitialInstances(
  context: Pick<vscode.ExtensionContext, 'globalState'>,
): Promise<NormalizedInstances> {
  const host: InstanceBootstrapHost = {
    readPersisted: rawSettings,
    isListAuthoritative: () => context.globalState.get<boolean>(LIST_AUTHORITATIVE_KEY) === true,
    persist: (instances, activeId) => persistInitialInstances(context, instances, activeId),
    markAuthoritative: () => writeAuthoritativeMarker(context),
  }
  return bootstrapInstances(host, instanceModelOptions())
}

export async function markInstancesAuthoritative(context: Pick<vscode.ExtensionContext, 'globalState'>): Promise<void> {
  await writeAuthoritativeMarker(context)
}
