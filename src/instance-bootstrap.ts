/**
 * First-run bootstrap of the instance list.
 *
 * This is its own module — and deliberately free of VS Code APIs — because the
 * failure it exists to survive is subtle: `dsh.instances` is a machine-scoped
 * VS Code setting, and writing it can fail on the very first run. A freshly
 * installed or updated extension may be activated in a window whose
 * configuration registry does not know `dsh.instances` yet, in which case the
 * write rejects with "Unable to write to User Settings because `dsh.instances`
 * is not a registered configuration".
 *
 * Nothing here may throw on that failure. The session must still get its
 * synthesized Default instance (otherwise the panel has no instance to start
 * and the user cannot get anywhere) and the failed save must surface as a
 * visible warning instead of an empty panel. The list simply persists on the
 * next successful write (normally after the next window reload).
 *
 * @module instance-bootstrap
 */

import {
  resolveInitialInstances,
  type DshInstance,
  type InstanceIssue,
  type InstanceModelOptions,
  type NormalizedInstances,
} from './instances.ts'

/** What bootstrapping needs from the host: the persisted values and a best-effort write. */
export interface InstanceBootstrapHost {
  /** The persisted settings values, read fresh from VS Code. */
  readPersisted(): { instances: unknown; activeId: unknown; legacyPort: unknown }
  /** Whether the instance list was persisted (or deliberately emptied) before. */
  isListAuthoritative(): boolean
  /** Persist the synthesized list; may reject when the setting is not writable. */
  persist(instances: readonly DshInstance[], activeId: string): Promise<void>
  /** Remember that the list is authoritative from now on. */
  markAuthoritative(): Promise<void>
}

/** One-line reason for a failed settings write. */
export function settingsWriteFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The warning shown when the synthesized list could not be written to settings. */
function persistFailureIssue(error: unknown): InstanceIssue {
  return {
    index: -1,
    field: 'entry',
    severity: 'warning',
    // Name the likely cause and the fix: this is almost always a fresh
    // install/update whose configuration contribution the running window has
    // not registered yet, and a reload makes the setting writable.
    message: `could not save the instance list to VS Code settings: ${settingsWriteFailure(error)} — `
      + 'the list stays usable in this session; reload the window if the extension was just installed or updated, '
      + 'then it will be saved',
  }
}

/**
 * Read the instance list a session starts from, synthesizing the legacy Default
 * when settings hold no instance yet.
 *
 * A failed persist is not fatal: the synthesized list is returned for this
 * session with a warning issue, because losing the only instance over a
 * not-yet-registered setting would leave the user unable to start dsh at all.
 */
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
    // Persist the stored form (the synthesized Default keeps `home: ''`), while
    // the session keeps the normalized list.
    await host.persist(result.stored, result.activeId)
    // The list itself is saved here; the marker is only a "do not synthesize
    // again" hint, so losing it costs a harmless re-synthesis, never data.
    await host.markAuthoritative().catch(() => {})
    return result
  } catch (error) {
    return {
      instances: result.instances,
      activeId: result.activeId,
      issues: [...result.issues, persistFailureIssue(error)],
    }
  }
}
