/**
 * Probing the configured Node.js version.
 *
 * dsh's engines admit `^22.19 || >=24`; the panel and the start flow ask this
 * module how the configured `dsh.nodePath` (or `node` on PATH) measures up.
 * The answer is memoized per Node path for the session: it cannot change
 * without a VS Code restart, and re-probing on every status refresh would spawn
 * a process every few seconds.
 *
 * @module server/node-check
 */

import { NODE_PROBE_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'

/** One `node --version` probe per Node path for the session (shared by checks and the panel). */
const nodeVersionCache = new Map<string, Promise<string>>()

/** The configured Node's version without the leading `v` ('' when it cannot be run). */
export function probeNodeVersion(nodePath: string): Promise<string> {
  const key = nodePath || 'node'
  let probe = nodeVersionCache.get(key)
  if (!probe) {
    probe = runFile(key, ['--version'], NODE_PROBE_TIMEOUT_MS).then((result) => (
      result.ok ? result.stdout.trim().replace(/^v/, '') : ''
    ))
    nodeVersionCache.set(key, probe)
  }
  return probe
}
