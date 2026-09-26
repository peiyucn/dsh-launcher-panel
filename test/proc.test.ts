/** Tests for `src/proc.ts` (subprocess capture) and `src/git.ts` (git output parsing). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeChildOutput, isProcessAlive, resolveCommand, runFile, runResolved } from '../src/proc.ts'
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

/**
 * `resolveCommand` replaced the old shell-quoting helpers. Its whole reason to
 * exist is that a Windows `.cmd` shim cannot be spawned by Node and must not be
 * handed to a shell, so the shim is read and its Node target run instead — the
 * arguments then stay arguments.
 */
test('resolveCommand passes a non-shim command through untouched', () => {
  // On every platform a plain executable needs no resolution: same file, no
  // extra leading arguments. (The `.cmd` branch is Windows-only, so it is
  // exercised by the test below on Windows and skipped elsewhere.)
  const r = resolveCommand(process.execPath)
  assert.deepEqual(r, { file: process.execPath, args: [] })
})

test('resolveCommand passes an argument array through without a shell', async () => {
  // The security property that matters: an argument containing shell
  // metacharacters is delivered as ONE argument, verbatim — it can never become
  // a second command, because no shell parses it.
  const hostile = 'x & echo INJECTED> marker & y'
  const r = await runResolved(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', hostile])
  assert.equal(r.ok, true)
  const argv = JSON.parse(r.stdout)
  assert.deepEqual(argv, [hostile])
})

test('resolveCommand refuses a batch file it cannot resolve, rather than spawning it', () => {
  if (process.platform !== 'win32') return // the refusal is Windows-specific
  // Node refuses to spawn `.cmd`/`.bat` directly (its CVE-2024-27980 guard), and
  // handing one to a shell is the injection hole this replaced. An unresolvable
  // shim must therefore be reported, not attempted.
  const bogus = join(tmpdir(), 'dsh-no-such-shim.cmd')
  assert.equal(resolveCommand(bogus), undefined)
})

test('resolveCommand reads a .cmd shim and returns its Node entry', () => {
  if (process.platform !== 'win32') return
  // The npm shim shape: a batch file that runs a script with `%dp0%` expanded to
  // its own directory. Written here rather than relying on a machine's pnpm.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shim-'))
  try {
    const entry = join(dir, 'entry.mjs')
    writeFileSync(entry, '')
    const shim = join(dir, 'tool.cmd')
    writeFileSync(shim, [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'endLocal & "%_prog%"  "%dp0%\\entry.mjs" %*',
      '',
    ].join('\r\n'))
    const r = resolveCommand(shim)
    assert.notEqual(r, undefined)
    // It runs the script with the current Node, not the shim through cmd.
    assert.equal(r?.file, process.execPath)
    assert.equal(r?.args[0], entry)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
