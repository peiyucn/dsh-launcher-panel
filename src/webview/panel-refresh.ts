/**
 * Serializing dashboard refreshes.
 *
 * The visible panel refreshes on a timer and every webview command asks for a
 * refresh afterwards. Without a gate those runs overlap: a slow probe (or a cold
 * status-page fetch) lets the next refresh start while the first is still in
 * flight, which multiplies per-instance TCP probes and can let an older
 * snapshot land after a newer one. This scheduler runs at most one task at a
 * time and merges every request that arrives meanwhile into a single trailing
 * run.
 *
 * Pure TypeScript: the panel injects the task and the tests drive it with
 * promise gates.
 *
 * @module webview/panel-refresh
 */

export interface RefreshScheduler {
  /**
   * Run the task now, or once more right after the current run when one is
   * already in flight. Concurrent requests are coalesced into that one run.
   */
  request(): Promise<void>
  /** Whether a run is currently in flight (a request would be merged). */
  readonly busy: boolean
}

/** Create a single-flight scheduler around `task`. */
export function createRefreshScheduler(task: () => Promise<void>): RefreshScheduler {
  let busy = false
  let dirty = false

  async function request(): Promise<void> {
    if (busy) {
      dirty = true
      return
    }
    busy = true
    try {
      do {
        dirty = false
        await task()
      } while (dirty)
    } finally {
      busy = false
    }
  }

  return {
    request,
    get busy() {
      return busy
    },
  }
}
