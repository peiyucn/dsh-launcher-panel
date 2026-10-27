import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canTransition, holdsHome, nextState, stopDecision, type InstanceState } from '../src/instance-state.ts'

test('start moves a stopped or failed instance to starting', () => {
  assert.equal(nextState('stopped', 'start'), 'starting')
  assert.equal(nextState('error', 'start'), 'starting')
  assert.equal(nextState('running', 'start'), undefined)
  assert.equal(nextState('stopping', 'start'), undefined)
})

test('ready moves starting to running and failure moves it to error', () => {
  assert.equal(nextState('starting', 'ready'), 'running')
  assert.equal(nextState('starting', 'fail'), 'error')
})

test('an unexpected exit returns a running instance to stopped', () => {
  assert.equal(nextState('running', 'exit'), 'stopped')
  assert.equal(nextState('running', 'lost'), 'stopped')
})

test('stop goes through stopping and only stopping completes to stopped', () => {
  assert.equal(nextState('running', 'stop'), 'stopping')
  assert.equal(nextState('starting', 'stop'), 'stopping')
  assert.equal(nextState('stopping', 'stop-complete'), 'stopped')
  assert.equal(nextState('stopping', 'fail'), 'error')
})

test('a starting instance cannot silently jump back to stopped', () => {
  assert.equal(nextState('starting', 'exit'), undefined)
  assert.equal(nextState('starting', 'lost'), undefined)
  assert.equal(nextState('starting', 'stop-complete'), undefined)
  assert.equal(nextState('starting', 'cleanup'), 'stopped')
})

test('a manual stop of a failed instance cleans error up to stopped', () => {
  assert.equal(nextState('error', 'cleanup'), 'stopped')
  assert.equal(nextState('stopped', 'cleanup'), 'stopped')
})

test('adoption moves a stopped/error instance to running', () => {
  assert.equal(nextState('stopped', 'adopt'), 'running')
  assert.equal(nextState('error', 'adopt'), 'running')
  assert.equal(nextState('running', 'adopt'), 'running')
})

test('canTransition only accepts edges the table defines', () => {
  assert.equal(canTransition('stopped', 'starting'), true)
  assert.equal(canTransition('starting', 'running'), true)
  assert.equal(canTransition('running', 'stopping'), true)
  assert.equal(canTransition('stopping', 'error'), true)
  assert.equal(canTransition('running', 'starting'), false)
  assert.equal(canTransition('stopping', 'running'), false)
  assert.equal(canTransition('stopping', 'starting'), false)
})

test('holdsHome keeps stopping and a still-alive error from sharing the home', () => {
  for (const state of ['running', 'starting', 'stopping'] as InstanceState[]) {
    assert.equal(holdsHome(state, false, false), true, `${state} must hold its home`)
  }
  assert.equal(holdsHome('error', true, false), true)
  assert.equal(holdsHome('error', false, true), true)
  assert.equal(holdsHome('error', false, false), false)
  assert.equal(holdsHome('stopped', false, false), false)
  assert.equal(holdsHome('stopped', false, true), false)
})

test('Stop asks before killing a port owner this runtime does not track', () => {
  assert.equal(stopDecision({ hasTrackedChild: true, portOpen: false, killUntracked: false }), 'kill')
  assert.equal(stopDecision({ hasTrackedChild: false, portOpen: true, killUntracked: false }), 'ask')
  assert.equal(stopDecision({ hasTrackedChild: false, portOpen: true, killUntracked: true }), 'kill')
  assert.equal(stopDecision({ hasTrackedChild: false, portOpen: false, killUntracked: false }), 'cleanup')
})

test('Stop no longer kills an untracked port owner by default', () => {
  const source = readFileSync(new URL('../src/server/instance-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /stop\(killUntracked = false\)/, 'InstanceRuntime.stop must default to not killing untracked owners')
  assert.match(source, /stopDecision\(\{/, 'the untracked-port rule must be the tested pure decision')
  assert.match(source, /needsStopConfirmation\(\)/, 'the UI needs a way to ask before the untracked kill')
})

test('log tail reads live in the vscode-free log-read module', () => {
  const source = readFileSync(new URL('../src/server/instance-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/log-read\.ts'/)
  assert.doesNotMatch(source, /function readLogTail\(/, 'the duplicated tail reader must not come back')
  assert.doesNotMatch(source, /function readTokenFromLog\(/, 'the duplicated token reader must not come back')
})
