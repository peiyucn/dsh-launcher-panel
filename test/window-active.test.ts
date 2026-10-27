import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const extension = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8')
const manager = readFileSync(new URL('../src/instances/manager.ts', import.meta.url), 'utf8')

test('configuration reload ignores activeInstance writes from other windows', () => {
  assert.match(extension, /affectsConfiguration\('dsh\.instances'\)/, 'list changes must still reload')
  assert.doesNotMatch(
    extension,
    /affectsConfiguration\('dsh\.activeInstance'\)/,
    'the shared user setting must not switch this window tab',
  )
})

test('reloading settings keeps this window active instance', () => {
  assert.match(
    manager,
    /applySettings\(readInstanceSettings\(\), this\.activeId\)/,
    'reload must pass the current active id so another window cannot override it',
  )
})
