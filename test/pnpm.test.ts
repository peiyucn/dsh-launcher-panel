/** Tests for pnpm discovery and capability checks in `src/pnpm.ts`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { findPnpm, pickPnpmFromPath, pnpmSupportsDangerouslyAllowAllBuilds, windowsPnpmCandidates } from '../src/pnpm.ts'

test('pnpmSupportsDangerouslyAllowAllBuilds gates on pnpm 10.16+', () => {
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('11.22.0'), true)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('10.16.0'), true)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('10.15.0'), false)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('9.15.4'), false)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds(''), false)
})

test('windowsPnpmCandidates lists the npm-global and pnpm shims', () => {
  const out = windowsPnpmCandidates({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
  assert.deepEqual(out, [
    join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'pnpm.cmd'),
    join('C:\\Users\\me\\AppData\\Local', 'pnpm', 'pnpm.cmd'),
  ])
  assert.deepEqual(windowsPnpmCandidates({}), [])
})

/**
 * The regression this pins (2026-09-30, real machine): `findPnpm` used to answer
 * with the bare name `pnpm` whenever `where pnpm` succeeded. `spawn` on Windows
 * does not expand PATHEXT (it only appends `.exe`), and `resolveCommand` only
 * unwraps `.cmd`/`.bat`, so the bare name was spawned as-is and failed with
 * `ENOENT` — measured directly:
 *
 *   spawn('pnpm', ['--version'])                      → error.code ENOENT
 *   spawn('…\\npm\\pnpm.cmd', ['--version'])           → error.code EINVAL (Node refuses .cmd)
 *
 * Because the spawn never produced a pid, the panel reported only
 * "Server failed to launch — no process id was reported" with an **empty**
 * server log, which made it look like dsh itself was broken.
 *
 * `where pnpm` prints the extensionless POSIX-style shim FIRST, so the fix is
 * to pick a launchable entry rather than the first line.
 */
test('pickPnpmFromPath skips the extensionless shim that where lists first', () => {
  // 真机上的实际顺序：先是无扩展名的 POSIX shim，然后才是 .cmd
  assert.equal(
    pickPnpmFromPath(['C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm', 'C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm.cmd'], 'win32'),
    'C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm.cmd',
  )
})

test('pickPnpmFromPath prefers a real .exe over any shim', () => {
  assert.equal(
    pickPnpmFromPath(['C:\\tools\\pnpm.cmd', 'C:\\tools\\pnpm.exe'], 'win32'),
    'C:\\tools\\pnpm.exe',
  )
})

test('pickPnpmFromPath gives up when Windows offers nothing launchable', () => {
  // 只剩无扩展名的那条 ⇒ 不能返回它（spawn 会 ENOENT）；交给 findPnpm 的候选路径兜底
  assert.equal(pickPnpmFromPath(['C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm'], 'win32'), undefined)
  assert.equal(pickPnpmFromPath([], 'win32'), undefined)
  assert.equal(pickPnpmFromPath(['', '   '], 'win32'), undefined)
})

test('pickPnpmFromPath returns the first match untouched on POSIX', () => {
  assert.equal(pickPnpmFromPath(['/usr/local/bin/pnpm', '/usr/bin/pnpm'], 'linux'), '/usr/local/bin/pnpm')
  assert.equal(pickPnpmFromPath([], 'darwin'), undefined)
})

test('findPnpm never answers with a bare name (that is the ENOENT shape)', async () => {
  const found = await findPnpm()
  // 本机装有 pnpm ⇒ 必须解析出**可启动的路径**，而不是光秃秃的 'pnpm'
  assert.ok(found !== undefined, 'expected pnpm to resolve on this machine')
  assert.notEqual(found, 'pnpm')
  if (process.platform === 'win32') {
    assert.match(found, /\.(exe|cmd|bat)$/i, `expected a launchable Windows path, got ${found}`)
  }
})
