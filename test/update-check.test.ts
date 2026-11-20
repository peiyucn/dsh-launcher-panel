import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const messages = readFileSync(new URL('../src/panel/messages.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/panel/panel.ts', import.meta.url), 'utf8')

test('the panel refresh handler delegates to the instance manager', () => {
  const handler = /private async refreshRequirements\([\s\S]*?\n {2}\}/.exec(messages)?.[0] ?? ''
  assert.match(handler, /manager\?\.checkUpdate\(true\)/, 'the handler must ask the manager for an update check')
  assert.doesNotMatch(handler, /manager\?\.refresh\(\)/, 'the trailing panel refresh already refreshes the manager')
  assert.doesNotMatch(handler, /clearRequirementsCaches/, 'the retired single-server check cache is gone')
  assert.match(messages, /await this\.host\.requestRefresh\(\)/, 'the message path must end in the scheduled refresh')
  assert.match(panel, /createRefreshScheduler/, 'refreshes must be serialized and merged')
})
test('an absent install never falls through to "up to date"', () => {
  const update = readFileSync(new URL('../src/dsh/update.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(update, /if \(!installed\) return \{ hasUpdate: false, label: '' \}/)
  assert.doesNotMatch(update, /if \(!checkout\) return \{ hasUpdate: false, label: '' \}/)
  assert.match(update, /missingDshUpdate\(\)/)
})
