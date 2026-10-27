/**
 * Regression test for the dashboard refresh path.
 *
 * The multi-instance manager owns update checks and lifecycle state; the panel
 * is a thin view that delegates to it. The retired single-server lifecycle
 * (a source-level in-flight counter) is gone — these assertions keep that
 * delegation from drifting back into the panel.
 *
 * The panel must not refresh the manager itself any more: every webview command
 * ends in `requestRefresh()`, whose single-flight scheduler runs the one
 * refresh that also refreshes the manager (`dashboard()` calls `refresh()`).
 * Asking the manager here as well doubled per-instance probes on one click.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the panel refresh handler delegates to the instance manager', () => {
  const panel = readFileSync(new URL('../src/panel.ts', import.meta.url), 'utf8')
  const branch = /case 'refreshRequirements':([\s\S]*?)break/.exec(panel)?.[1] ?? ''
  assert.match(branch, /manager\?\.checkUpdate\(true\)/, 'the handler must ask the manager for an update check')
  assert.doesNotMatch(branch, /manager\?\.refresh\(\)/, 'the trailing panel refresh already refreshes the manager')
  assert.doesNotMatch(branch, /clearRequirementsCaches/, 'the retired single-server check cache is gone')

  // The trailing refresh is the single-flight scheduler, not a direct call.
  assert.match(panel, /await this\.requestRefresh\(\)/, 'the message path must end in the scheduled refresh')
  assert.match(panel, /createRefreshScheduler/, 'refreshes must be serialized and merged')
})
