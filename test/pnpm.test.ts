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

test('pickPnpmFromPath skips the extensionless shim that where lists first', () => {
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
  if (found === undefined) return
  assert.notEqual(found, 'pnpm')
  if (process.platform === 'win32') {
    assert.match(found, /\.(exe|cmd|bat)$/i, `expected a launchable Windows path, got ${found}`)
  }
})
