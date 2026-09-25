/** Tests for `src/proc.ts` (subprocess capture) and `src/git.ts` (git output parsing). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { decodeChildOutput, isProcessAlive, psQuote, quoteCmdArg, runFile } from '../src/proc.ts'
import { parseLocalProxySettings } from '../src/git.ts'

/**
 * Whether this environment lets a process capture another process's piped
 * output.
 *
 * Sandboxes that forbid named pipes (including the DSH agent sandbox in its
 * confined modes) fail every subprocess capture with EPERM. The `runFile` tests
 * below genuinely need that capability, so they are skipped with a stated
 * reason instead of reported as failures — a red suite that everyone has to
 * re-diagnose is worse than an honest skip, and a real defect in `runFile`
 * still surfaces (it would not manifest as EPERM).
 */
const canSpawnWithPipes = await new Promise<boolean>((resolve) => {
  try {
    execFile(process.execPath, ['-e', 'process.stdout.write("1")'], (error) => {
      resolve(error === null || (error as { code?: string }).code !== 'EPERM')
    })
  } catch {
    resolve(false)
  }
})
const skipReason = canSpawnWithPipes
  ? false
  : 'this environment forbids capturing a subprocess output pipe (EPERM)'

test('decodeChildOutput keeps UTF-8 intact and recovers a GBK console message', () => {
  // Real UTF-8 must never be reinterpreted through the legacy code page.
  assert.equal(decodeChildOutput(Buffer.from('错误: 中文路径', 'utf8')), '错误: 中文路径')
  assert.equal(decodeChildOutput(Buffer.from('plain ascii', 'utf8')), 'plain ascii')
  assert.equal(decodeChildOutput(Buffer.alloc(0)), '')

  // taskkill on a Chinese Windows emits GBK; these are the bytes that machine
  // actually produces. The expected text is written escaped so the assertion
  // stays readable next to the raw byte list.
  const gbk = Buffer.from([0xB4, 0xED, 0xCE, 0xF3, 0x3A, 0x20, 0xCE, 0xDE, 0xB7, 0xA8, 0xD6, 0xD5, 0xD6, 0xB9])
  assert.equal(decodeChildOutput(gbk), '\u9519\u8BEF: \u65E0\u6CD5\u7EC8\u6B62')
  // The lossy reading this replaces is what filled the activity log with U+FFFD.
  assert.equal(gbk.toString('utf8').includes('\uFFFD'), true)
})

test('isProcessAlive reports own pid alive and an impossible pid dead', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999999999), false)
})

test('quoteCmdArg quotes args containing special characters', () => {
  assert.equal(quoteCmdArg('a b'), '"a b"')
  assert.equal(quoteCmdArg('a&b'), '"a&b"')
  assert.equal(quoteCmdArg('a|b'), '"a|b"')
  assert.equal(quoteCmdArg('plain'), 'plain')
})

test('psQuote doubles single quotes', () => {
  assert.equal(psQuote("it's"), "it''s")
  assert.equal(psQuote('plain'), 'plain')
})

test('runFile reports success with stdout and no error', { skip: skipReason }, async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stdout.write("hello")'])
  assert.equal(r.ok, true)
  assert.equal(r.stdout.trim(), 'hello')
  assert.equal(r.error, undefined)
  assert.equal(r.timedOut, undefined)
  assert.equal(r.code, undefined)
})

test('runFile keeps the exit code and last stderr line of a failed command', { skip: skipReason }, async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stderr.write("first\\nsecond\\n"); process.exit(3)'])
  assert.equal(r.ok, false)
  assert.equal(r.code, 3)
  assert.equal(r.timedOut, undefined)
  // The *last* line is the cause; earlier lines are usually context.
  assert.equal(r.error, 'second')
})

test('runFile marks a timeout as such instead of a bare failure', { skip: skipReason }, async () => {
  const r = await runFile(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], 600)
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(r.code, undefined)
  assert.match(r.error ?? '', /^timed out after 1s$/)
})

test('runFile reports a spawn failure with its reason', { skip: skipReason }, async () => {
  const r = await runFile('definitely-not-a-real-binary-xyz', [])
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, undefined)
  assert.equal(r.code, undefined)
  assert.ok((r.error ?? '').length > 0)
})

test('parseLocalProxySettings reads the format git actually prints', () => {
  // 格式取自本机 git 2.55 的实际输出（`git config --global --get-regexp proxy`）。
  const real = 'http.proxy http://127.0.0.1:7897\nhttps.proxy http://127.0.0.1:7897'
  assert.deepEqual(parseLocalProxySettings(real), [
    { key: 'http.proxy', host: '127.0.0.1', port: 7897 },
    { key: 'https.proxy', host: '127.0.0.1', port: 7897 },
  ])
})

test('parseLocalProxySettings ignores non-loopback and malformed proxies', () => {
  // 远端代理不可达可能只是当前网络位置问题，不该由我们断言。
  assert.deepEqual(parseLocalProxySettings('http.proxy http://proxy.corp.example:8080'), [])
  assert.deepEqual(parseLocalProxySettings('http.proxy http://127.0.0.1'), [])
  assert.deepEqual(parseLocalProxySettings('http.proxy not-a-url'), [])
  assert.deepEqual(parseLocalProxySettings('user.name someone'), [])
  assert.deepEqual(parseLocalProxySettings(''), [])
})

test('parseLocalProxySettings accepts localhost and IPv6 loopback', () => {
  assert.deepEqual(parseLocalProxySettings('http.proxy http://localhost:7890'), [
    { key: 'http.proxy', host: 'localhost', port: 7890 },
  ])
  assert.deepEqual(parseLocalProxySettings('http.proxy http://[::1]:7890'), [
    { key: 'http.proxy', host: '::1', port: 7890 },
  ])
})
