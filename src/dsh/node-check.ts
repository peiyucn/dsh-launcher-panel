import { NODE_PROBE_TIMEOUT_MS } from '../shared/timing.ts'
import { runFile } from '../shared/proc.ts'

// The version cannot change without a host restart, and status refreshes would spawn a probe every few seconds.
const nodeVersionCache = new Map<string, Promise<string>>()

export function probeNodeVersion(nodePath: string): Promise<string> {
  const key = nodePath || 'node'
  let probe = nodeVersionCache.get(key)
  if (probe === undefined) {
    probe = runFile(key, ['--version'], NODE_PROBE_TIMEOUT_MS)
      .then((result) => (result.ok ? result.stdout.trim().replace(/^v/, '') : ''))
    nodeVersionCache.set(key, probe)
  }
  return probe
}
