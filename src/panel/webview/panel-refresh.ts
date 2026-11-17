interface RefreshScheduler {
  request(): Promise<void>
  readonly busy: boolean
}

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

  return { request, get busy() { return busy } }
}
