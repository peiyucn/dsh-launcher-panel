/** Tests for the pure config/text helpers in `src/env.ts`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BROWSER,
  extractWebToken,
  normalizeBrowser,
  npmSpecForChannel,
  parseImportMetaMainProbe,
  parseNpmChannel,
  shouldOpenBrowser,
  silentExitHint,
  toEnglish,
} from '../src/env.ts'

test('normalizeBrowser collapses config values to known choices', () => {
  assert.equal(normalizeBrowser('external'), 'external')
  assert.equal(normalizeBrowser('built-in'), 'built-in')
  assert.equal(normalizeBrowser(undefined), DEFAULT_BROWSER)
  assert.equal(normalizeBrowser('garbage'), DEFAULT_BROWSER)
  assert.equal(normalizeBrowser(''), DEFAULT_BROWSER)
})

test('shouldOpenBrowser honours auto-open and explicit re-opens', () => {
  assert.equal(shouldOpenBrowser(undefined, false), true)
  assert.equal(shouldOpenBrowser(true, false), true)
  assert.equal(shouldOpenBrowser(false, false), false)
  assert.equal(shouldOpenBrowser(false, true), true)
  assert.equal(shouldOpenBrowser(undefined, true), true)
})

test('parseImportMetaMainProbe accepts only a true probe answer', () => {
  assert.equal(parseImportMetaMainProbe('true'), true)
  assert.equal(parseImportMetaMainProbe('true\r\n'), true)
  // Node < 22.18 / < 24.2 stringifies the missing binding as undefined.
  assert.equal(parseImportMetaMainProbe('undefined'), false)
  assert.equal(parseImportMetaMainProbe(''), false)
  assert.equal(parseImportMetaMainProbe('false'), false)
  assert.equal(parseImportMetaMainProbe('v24.0.0'), false)
})

test('silentExitHint explains only the guarded-entry silent exit', () => {
  const base = { dshVersion: '0.1.5-rc.1', nodeVersion: '24.0.0', supportsImportMetaMain: false, outputLines: 0 }
  const hint = silentExitHint(base)
  assert.ok(hint?.includes('import.meta.main'))
  assert.ok(hint?.includes('Node v24.0.0'))
  // A dsh older than the guard, captured output, or a capable Node: nothing to add.
  assert.equal(silentExitHint({ ...base, dshVersion: '0.1.2-rc.1' }), undefined)
  assert.equal(silentExitHint({ ...base, outputLines: 3 }), undefined)
  assert.equal(silentExitHint({ ...base, supportsImportMetaMain: true }), undefined)
  // An unknown version must not produce a claim about that version.
  assert.equal(silentExitHint({ ...base, dshVersion: '' }), undefined)
  assert.ok(silentExitHint({ ...base, nodeVersion: '' })?.includes('The configured Node'))
})

test('toEnglish strips non-ASCII and parentheticals', () => {
  assert.equal(toEnglish('DeepSeek V3 Chat API（对话）'), 'DeepSeek V3 Chat API')
  assert.equal(toEnglish('全是中文'), '')
})

test('extractWebToken reads the token from dsh web startup output', () => {
  assert.equal(extractWebToken('dsh web: http://127.0.0.1:3080/?token=e9FDDvp1cDfkePv9wnWBMCJLPOjzoi7qLaSIQghrElE'), 'e9FDDvp1cDfkePv9wnWBMCJLPOjzoi7qLaSIQghrElE')
  assert.equal(extractWebToken('dsh web: http://127.0.0.1:3080'), undefined)
  assert.equal(extractWebToken('token=abc'), undefined)
  assert.equal(extractWebToken(''), undefined)
})

test('parseNpmChannel normalizes channel settings', () => {
  assert.equal(parseNpmChannel('next'), 'next')
  assert.equal(parseNpmChannel('alpha'), 'alpha')
  assert.equal(parseNpmChannel('latest'), 'latest')
  assert.equal(parseNpmChannel(undefined), 'latest')
  assert.equal(parseNpmChannel('garbage'), 'latest')
})

test('npmSpecForChannel maps channels to npm specs', () => {
  assert.equal(npmSpecForChannel('latest'), '@deepseek-ai/dsh')
  assert.equal(npmSpecForChannel('next'), '@deepseek-ai/dsh@next')
  assert.equal(npmSpecForChannel('alpha'), '@deepseek-ai/dsh@alpha')
})
