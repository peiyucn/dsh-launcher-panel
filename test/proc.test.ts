import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { decodeChildOutput, isProcessAlive, resolveCommand, resolveCommandEntry, runFile, runResolved } from '../src/proc.ts'
import { parseLocalProxySettings } from '../src/git.ts'

// Sandboxes that forbid named pipes fail every subprocess capture with EPERM; skip those tests
// with a stated reason rather than reporting red noise.
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
  assert.equal(decodeChildOutput(Buffer.from('错误: 中文路径', 'utf8')), '错误: 中文路径')
  assert.equal(decodeChildOutput(Buffer.from('plain ascii', 'utf8')), 'plain ascii')
  assert.equal(decodeChildOutput(Buffer.alloc(0)), '')

  const gbk = Buffer.from([0xB4, 0xED, 0xCE, 0xF3, 0x3A, 0x20, 0xCE, 0xDE, 0xB7, 0xA8, 0xD6, 0xD5, 0xD6, 0xB9])
  assert.equal(decodeChildOutput(gbk), '\u9519\u8BEF: \u65E0\u6CD5\u7EC8\u6B62')
  assert.equal(gbk.toString('utf8').includes('\uFFFD'), true)
})

test('isProcessAlive reports own pid alive and an impossible pid dead', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999999999), false)
})

test('resolveCommand passes a non-shim command through untouched', () => {
  const r = resolveCommand(process.execPath)
  assert.deepEqual(r, { file: process.execPath, args: [] })
})

test('resolveCommand passes an argument array through without a shell', async () => {
  const hostile = 'x & echo INJECTED> marker & y'
  const r = await runResolved(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', hostile])
  assert.equal(r.ok, true)
  const argv = JSON.parse(r.stdout)
  assert.deepEqual(argv, [hostile])
})

test('resolveCommand refuses a batch file it cannot resolve, rather than spawning it', () => {
  if (process.platform !== 'win32') return
  const bogus = join(tmpdir(), 'dsh-no-such-shim.cmd')
  assert.equal(resolveCommand(bogus), undefined)
})

test('resolveCommand reads a .cmd shim and returns its Node entry', () => {
  if (process.platform !== 'win32') return
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
    assert.equal(r?.file, process.execPath)
    assert.equal(r?.args[0], entry)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const SHIM_CASES: Array<{ name: string; relative: string; body: string }> = [
  { name: '%~dp0 (corepack / hand-written shape)', relative: join('sub', 'tool.cjs'), body: '"%~dp0\\sub\\tool.cjs" %*' },
  { name: 'an unquoted target', relative: join('sub', 'tool.js'), body: '%dp0%\\sub\\tool.js %*' },
  { name: 'a relative-up target', relative: join('..', 'lib', 'tool.mjs'), body: '"%~dp0\\..\\lib\\tool.mjs" %*' },
]

for (const shimCase of SHIM_CASES) {
  test(`resolveCommandEntry resolves a shim using ${shimCase.name}`, () => {
    if (process.platform !== 'win32') return
    const root = mkdtempSync(join(tmpdir(), 'dsh-shim-shape-'))
    try {
      const dir = join(root, 'bin')
      mkdirSync(dir, { recursive: true })
      const entry = resolve(dir, shimCase.relative)
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(entry, '')
      const shim = join(dir, 'tool.cmd')
      writeFileSync(shim, `@echo off\r\nnode ${shimCase.body}\r\n`)
      const resolution = resolveCommandEntry(shim)
      assert.equal(resolution.ok, true, resolution.ok ? '' : resolution.reason)
      if (!resolution.ok) return
      assert.equal(resolution.command.file, process.execPath)
      assert.equal(resolution.command.args[0], entry)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('resolveCommandEntry handles a verbatim Corepack-style shim (IF/ELSE, ~dp0)', () => {
  if (process.platform !== 'win32') return
  const root = mkdtempSync(join(tmpdir(), 'dsh-corepack-shim-'))
  try {
    const nodeDir = join(root, 'nodejs')
    mkdirSync(nodeDir, { recursive: true })
    const entry = join(root, 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '')
    const shim = join(nodeDir, 'pnpm.cmd')
    writeFileSync(shim, [
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\lib\\node_modules\\corepack\\dist\\corepack.js" pnpm %*',
      ') ELSE (',
      '  @SETLOCAL',
      '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
      '  node  "%~dp0\\..\\lib\\node_modules\\corepack\\dist\\corepack.js" pnpm %*',
      ')',
      '',
    ].join('\r\n'))
    const resolution = resolveCommandEntry(shim)
    assert.equal(resolution.ok, true, resolution.ok ? '' : resolution.reason)
    if (!resolution.ok) return
    assert.equal(resolution.command.file, process.execPath)
    assert.deepEqual(resolution.command.args, [entry])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveCommandEntry runs a shim that points straight at an executable', () => {
  if (process.platform !== 'win32') return
  const root = mkdtempSync(join(tmpdir(), 'dsh-exe-shim-'))
  try {
    const packageDir = join(root, 'node_modules', 'pnpm')
    mkdirSync(packageDir, { recursive: true })
    const exe = join(packageDir, 'pnpm.exe')
    writeFileSync(exe, '')
    const shim = join(root, 'pnpm.cmd')
    writeFileSync(shim, [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*',
      '',
    ].join('\r\n'))
    const resolution = resolveCommandEntry(shim)
    assert.equal(resolution.ok, true, resolution.ok ? '' : resolution.reason)
    if (!resolution.ok) return
    assert.equal(resolution.command.file, exe)
    assert.deepEqual(resolution.command.args, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveCommandEntry explains why a shim could not be resolved', async () => {
  if (process.platform !== 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shim-broken-'))
  try {
    const missingTarget = join(dir, 'missing.cmd')
    writeFileSync(missingTarget, '@echo off\r\nnode "%~dp0\\gone.cjs" %*\r\n')
    const missing = resolveCommandEntry(missingTarget)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.reason, /does not exist/u)
    const unresolved = await runResolved(missingTarget, [])
    assert.equal(unresolved.ok, false)
    assert.match(unresolved.error ?? '', /does not exist/u)

    const noEntry = join(dir, 'nested.cmd')
    writeFileSync(noEntry, '@echo off\r\ncall "%~dp0\\inner.cmd" %*\r\n')
    const empty = resolveCommandEntry(noEntry)
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.match(empty.reason, /names no program/u)

    assert.equal(resolveCommand(join(dir, 'no-such-file.cmd')), undefined)
    const unreadable = resolveCommandEntry(join(dir, 'no-such-file.cmd'))
    assert.equal(unreadable.ok, false)
    if (!unreadable.ok) assert.match(unreadable.reason, /could not be read/u)
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
  const real = 'http.proxy http://127.0.0.1:7897\nhttps.proxy http://127.0.0.1:7897'
  assert.deepEqual(parseLocalProxySettings(real), [
    { key: 'http.proxy', host: '127.0.0.1', port: 7897 },
    { key: 'https.proxy', host: '127.0.0.1', port: 7897 },
  ])
})

test('parseLocalProxySettings ignores non-loopback and malformed proxies', () => {
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
