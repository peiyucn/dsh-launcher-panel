import {
  resolveInitialInstances,
  type DshInstance,
  type InstanceModelOptions,
  type NormalizedInstances,
} from './model.ts'

export interface InstanceBootstrapHost {
  readPersisted(): { instances: unknown; activeId: unknown; legacyPort: unknown }
  isListAuthoritative(): boolean
  persist(instances: readonly DshInstance[], activeId: string): Promise<void>
  markAuthoritative(): Promise<void>
}

export function settingsWriteFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function bootstrapInstances(
  host: InstanceBootstrapHost,
  options: InstanceModelOptions,
): Promise<NormalizedInstances> {
  const persisted = host.readPersisted()
  const result = resolveInitialInstances(
    persisted.instances,
    persisted.activeId,
    persisted.legacyPort,
    host.isListAuthoritative(),
    options,
  )
  if (!result.synthesized) return result

  try {
    await host.persist(result.stored, result.activeId)
    await host.markAuthoritative().catch(() => {})
    return result
  } catch (error) {
    return {
      instances: result.instances,
      activeId: result.activeId,
      issues: [...result.issues, {
        index: -1,
        field: 'entry',
        severity: 'warning',
        message: `could not save the instance list to VS Code settings: ${settingsWriteFailure(error)} — `
          + 'the list stays usable in this session; reload the window if the extension was just installed or updated, '
          + 'then it will be saved',
      }],
    }
  }
}
