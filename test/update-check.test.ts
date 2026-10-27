import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panel = readFileSync(new URL('../src/panel/panel.ts', import.meta.url), 'utf8')

// The panel must not refresh the manager itself: the trailing scheduled refresh
// already does it through `dashboard()`, so a second call doubles probes.
test('the panel refresh handler delegates to the instance manager', () => {
  const handler = /private async refreshRequirements\([\s\S]*?\n {2}\}/.exec(panel)?.[0] ?? ''
  assert.match(handler, /manager\?\.checkUpdate\(true\)/, 'the handler must ask the manager for an update check')
  assert.doesNotMatch(handler, /manager\?\.refresh\(\)/, 'the trailing panel refresh already refreshes the manager')
  assert.doesNotMatch(handler, /clearRequirementsCaches/, 'the retired single-server check cache is gone')
  assert.match(panel, /await this\.requestRefresh\(\)/, 'the message path must end in the scheduled refresh')
  assert.match(panel, /createRefreshScheduler/, 'refreshes must be serialized and merged')
})
