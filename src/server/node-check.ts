/**
 * Whether the configured Node can actually run dsh, and what to say when it
 * cannot.
 *
 * Two checks live here because they answer different questions at different
 * times. The version check runs once at activation — dsh's engines admit
 * `^22.19 || >=24`, so anything older is refused before a start is attempted.
 * The `import.meta.main` probe runs only *after* a start already died with no
 * output, because that is the one failure it explains: Node 24.0/24.1 satisfies
 * the engines range but lacks the binding dsh ≥ 0.1.3-alpha.2 boots through, so
 * dsh exits silently.
 *
 * Both are memoized for the session: the answer cannot change without a VS Code
 * restart, and re-probing on every status refresh would spawn a process every
 * few seconds.
 *
 * @module server/node-check
 */

import * as vscode from 'vscode'
import { parseImportMetaMainProbe, silentExitHint } from '../env.ts'
import { NODE_PROBE_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'

/** Node.js engines range the harness requires: ^22.19 || >=24. */
export const NODE_MIN_MAJOR = 24
export const NODE_22_MIN_MINOR = 19

/** What the Node check needs from the lifecycle it runs inside. */
export interface NodeCheckHost {
  /** The configured `dsh.nodePath`, or '' to use PATH. */
  nodePath: () => string
  /** Report the outcome into the panel feed. */
  addActivity: (line: string, isBusy?: boolean) => number
  /** Record availability for the status line. */
  setNodeState: (state: 'unknown' | 'ok' | 'missing') => void
  /** Record the detected version ('' when unknown). */
  setNodeVersion: (version: string) => void
  /** The configured Node's version without the leading `v` ('' when unknown). */
  nodeVersion: () => string
  /** Server output lines captured for the run that just exited. */
  outputLineCount: () => number
}

/** Whether Node.js is present and satisfies the harness engines range. */
async function checkNode(nodePath: string): Promise<{ ok: boolean; version: string }> {
  const result = await runFile(nodePath || 'node', ['--version'], NODE_PROBE_TIMEOUT_MS)
  const version = result.ok ? result.stdout.trim().replace(/^v/, '') : ''
  if (!result.ok) return { ok: false, version: '' }
  const match = /^v?(\d+)\.(\d+)/.exec(result.stdout.trim())
  if (!match) return { ok: false, version }
  const major = Number(match[1])
  const minor = Number(match[2])
  return { ok: major >= NODE_MIN_MAJOR || (major === 22 && minor >= NODE_22_MIN_MINOR), version }
}

/** Memoized one-shot Node check, run once at extension activation. */
let nodeChecked: Promise<void> | undefined

/**
 * Check Node once (memoized) and cache the result. Called at activation so
 * Start and the status refresh never re-probe Node.
 */
export function checkNodeOnce(host: NodeCheckHost): Promise<void> {
  if (!nodeChecked) {
    nodeChecked = (async () => {
      const r = await checkNode(host.nodePath())
      host.setNodeState(r.ok ? 'ok' : 'missing')
      host.setNodeVersion(r.version)
      if (!r.ok) {
        host.addActivity(`✗ Node.js not found (need 22.x >= 22.${NODE_22_MIN_MINOR} or >= ${NODE_MIN_MAJOR})`)
        void vscode.window.showErrorMessage(`DeepSeek Harness requires Node.js 22.x (22.${NODE_22_MIN_MINOR} or later) or >= ${NODE_MIN_MAJOR}. Install it from https://nodejs.org and restart VS Code.`)
      }
    })()
  }
  return nodeChecked
}

/** Memoized `import.meta.main` capability probe for the configured Node. */
let importMetaMainProbe: Promise<boolean> | undefined

/**
 * Probe whether the configured Node exposes `import.meta.main`: dsh ≥
 * 0.1.3-alpha.2 runs its CLI behind that guard, but dsh's engines still admit
 * Node 24.0/24.1, where the binding does not exist and dsh exits silently with
 * no output.
 *
 * Only consulted after a start already failed without any output; a failed
 * probe reports support, so a broken probe never claims a Node lacks something
 * it actually has.
 */
function nodeSupportsImportMetaMain(nodePath: string): Promise<boolean> {
  if (!importMetaMainProbe) {
    importMetaMainProbe = runFile(
      nodePath || 'node',
      ['--input-type=module', '-e', 'process.stdout.write(String(import.meta.main))'],
      NODE_PROBE_TIMEOUT_MS,
    ).then((r) => (r.ok ? parseImportMetaMainProbe(r.stdout) : true))
  }
  return importMetaMainProbe
}

/** Whether the silent-exit diagnosis was already raised as a toast this session. */
let silentExitToastShown = false

/** Explain a server that died before opening its port without printing anything. */
export async function reportSilentExit(host: NodeCheckHost, version: string): Promise<void> {
  const hint = silentExitHint({
    dshVersion: version,
    nodeVersion: host.nodeVersion(),
    supportsImportMetaMain: await nodeSupportsImportMetaMain(host.nodePath()),
    outputLines: host.outputLineCount(),
  })
  if (hint === undefined) return
  host.addActivity(`✗ ${hint}`)
  if (silentExitToastShown) return
  silentExitToastShown = true
  void vscode.window.showErrorMessage(`DeepSeek Harness: ${hint}.`)
}
