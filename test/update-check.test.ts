/**
 * Regression test for the dashboard refresh path.
 *
 * The multi-instance manager owns update checks and lifecycle state; the panel
 * is a thin view that delegates to it. The retired single-server lifecycle
 * (a source-level in-flight counter) is gone — these assertions keep that
 * delegation from drifting back into the panel.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the panel refresh handler delegates to the instance manager', () => {
  const panel = readFileSync(new URL('../src/panel.ts', import.meta.url), 'utf8')
  const branch = /case 'refreshRequirements':([\s\S]*?)break/.exec(panel)?.[1] ?? ''
  assert.match(branch, /manager\?\.checkUpdate\(true\)/, 'the handler must ask the manager for an update check')
  assert.match(branch, /manager\?\.refresh\(\)/, 'the handler must refresh the instance manager')
  assert.doesNotMatch(branch, /clearRequirementsCaches/, 'the retired single-server check cache is gone')
})
