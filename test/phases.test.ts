/** Tests for the server lifecycle phase machine in `src/phases.ts`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canTransition } from '../src/phases.ts'

test('canTransition allows only valid server phase transitions', () => {
  assert.equal(canTransition('stopped', 'starting'), true)
  assert.equal(canTransition('starting', 'installing'), true)
  assert.equal(canTransition('installing', 'starting'), true)
  assert.equal(canTransition('installing', 'stopping'), true)
  assert.equal(canTransition('installing', 'stopped'), true)
  assert.equal(canTransition('starting', 'running'), true)
  assert.equal(canTransition('starting', 'stopping'), true)
  assert.equal(canTransition('starting', 'stopped'), true)
  assert.equal(canTransition('running', 'stopping'), true)
  assert.equal(canTransition('stopping', 'stopped'), true)
  assert.equal(canTransition('stopped', 'installing'), false)
  assert.equal(canTransition('installing', 'running'), false)
  assert.equal(canTransition('stopped', 'running'), false)
  assert.equal(canTransition('running', 'starting'), false)
  assert.equal(canTransition('running', 'stopped'), false)
  assert.equal(canTransition('stopped', 'stopping'), false)
})
