import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readLogTail, readLogTailBytes, readTokenFromLog, sanitizeStartupLines } from '../src/shared/logs.ts'

function tempLog(t: { after: (fn: () => void) => void }, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-read-'))
  const file = path.join(dir, 'server.log')
  fs.writeFileSync(file, text, 'utf8')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

test('readLogTail returns the last non-empty lines', (t) => {
  const file = tempLog(t, 'one\n\ntwo\r\nthree\n')
  assert.deepEqual(readLogTail(file, 2), ['two', 'three'])
  assert.deepEqual(readLogTail(file), ['one', 'two', 'three'])
})

test('readLogTail returns no lines for a missing file', () => {
  assert.deepEqual(readLogTail(path.join(os.tmpdir(), 'dsh-log-read-does-not-exist.log')), [])
  assert.equal(readLogTailBytes(path.join(os.tmpdir(), 'dsh-log-read-does-not-exist.log')), undefined)
})

test('readLogTailBytes only reads the bounded tail of a large log', (t) => {
  const file = tempLog(t, `START-OF-FILE\n${'x'.repeat(4096)}\nEND-OF-FILE\n`)
  const tail = readLogTailBytes(file, 1024)
  assert.ok(tail !== undefined)
  assert.equal(tail.includes('START-OF-FILE'), false, 'the head must not be read for a bounded tail')
  assert.equal(tail.includes('END-OF-FILE'), true)
})

test('readTokenFromLog returns the newest launch token', (t) => {
  const file = tempLog(t, [
    'dsh web listening on http://127.0.0.1:31001/?token=firsttoken1234',
    'some unrelated output',
    'dsh web listening on http://127.0.0.1:31001/?token=newertoken9999',
  ].join('\n'))
  assert.equal(readTokenFromLog(file), 'newertoken9999')
})

test('readTokenFromLog is undefined when the log has no token', (t) => {
  const file = tempLog(t, 'plain startup output with no launch URL\n')
  assert.equal(readTokenFromLog(file), undefined)
})

test('the shared log helpers stay free of the live tail pump', () => {
  const source = fs.readFileSync(new URL('../src/shared/logs.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /class LogTailPump/, 'the stateful pump lives in the instance runtime')
})

test('startup output drops periodic model-listing chatter', () => {
  const lines = [
    '[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)',
    '[llm-deepseek-account] model listing from https://api.deepseek.com/models failed (LlmError: timed out after 5000 ms); keeping the previous catalog',
    'dsh: skipping profile bundle "@dsh-sparrow/dsh-theme-tone": Error: incompatible',
  ]
  assert.deepEqual(sanitizeStartupLines(lines), ['dsh: skipping profile bundle "@dsh-sparrow/dsh-theme-tone": Error: incompatible'])
})

test('startup output masks launch tokens before they can reach the webview', () => {
  const lines = [
    'dsh web: http://127.0.0.1:3080/?token=secret-token_123',
    'plain error line',
  ]
  assert.deepEqual(sanitizeStartupLines(lines), ['dsh web: http://127.0.0.1:3080/?token=***', 'plain error line'])
})

test('sanitizeStartupLines leaves unrelated log lines untouched', () => {
  const lines = ['dsh: initialization failed: ENOENT', '  at somewhere (file.ts:1:1)']
  assert.deepEqual(sanitizeStartupLines(lines), lines)
})
