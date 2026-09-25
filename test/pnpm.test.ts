/** Tests for pnpm discovery and capability checks in `src/pnpm.ts`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pnpmSupportsDangerouslyAllowAllBuilds, windowsPnpmCandidates } from '../src/pnpm.ts'

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
