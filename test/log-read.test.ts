/** Tests for `src/server/log-read.ts`: bounded log-tail and launch-token reads. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readLogTail, readLogTailBytes, readTokenFromLog } from '../src/server/log-read.ts'

/** Write `text` to a fresh temp file and clean the directory up after the test. */
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
