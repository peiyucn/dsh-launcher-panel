import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BROWSER,
  extractWebToken,
  normalizeBrowser,
  npmSpecForChannel,
  parseNpmChannel,
  shouldOpenBrowser,
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
