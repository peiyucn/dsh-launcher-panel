import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ObservedState } from '../src/instances/runtime/observed-state.ts'
import type { ObservedProcessInfo } from '../src/instances/observed-process.ts'

test('ObservedState exposes the token and status fields from the resolver', async () => {
  const info: ObservedProcessInfo = {
    pid: 701,
    packagePath: '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    version: '0.2.1-rc.5',
    token: 'AbCdEfGh12345678',
  }
  const state = new ObservedState(async () => info)
  assert.equal(await state.resolveToken(3082), info.token)
  assert.equal(state.packagePath, info.packagePath)
  assert.equal(state.version, info.version)
  assert.equal(state.tokenError, '')
})

test('ObservedState surfaces the resolver error and clears on reset', async () => {
  const state = new ObservedState(async () => ({ tokenError: 'no token source' }))
  assert.equal(await state.resolveToken(3082), undefined)
  assert.equal(state.tokenError, 'no token source')
  state.reset()
  assert.equal(state.tokenError, '')
  assert.equal(state.packagePath, '')
  assert.equal(state.version, '')
})
