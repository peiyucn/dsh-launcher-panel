import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canTransition, holdsHome, nextState, stopPlan, type InstanceState } from '../src/instances/state.ts'

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

test('Stop kills a tracked child, a positively identified server, or nothing', () => {
  assert.equal(stopPlan({ hasTrackedChild: true, portOpen: true, identified: false }), 'kill-tracked')
  assert.equal(stopPlan({ hasTrackedChild: true, portOpen: false, identified: false }), 'kill-tracked')
  assert.equal(stopPlan({ hasTrackedChild: false, portOpen: true, identified: true }), 'kill-identified')
  assert.equal(stopPlan({ hasTrackedChild: false, portOpen: true, identified: false }), 'unidentified')
  assert.equal(stopPlan({ hasTrackedChild: false, portOpen: false, identified: false }), 'cleanup')
})

function runtimeSource(): string {
  return readFileSync(new URL('../src/instances/runtime/runtime.ts', import.meta.url), 'utf8')
}

test('Stop only kills a port owner identified as this instance dsh server', () => {
  const source = runtimeSource()
  assert.match(source, /stop\(\): Promise<boolean>/, 'InstanceRuntime.stop must not take a caller-supplied kill grant')
  assert.match(source, /stopPlan\(\{/, 'the stop rule must be the tested pure decision')
  assert.match(source, /findDshServerPidsByPort\(this\.instance\.port\)/, 'an untracked server is identified by command line')
  assert.doesNotMatch(source, /findPortOwner|killUntracked|needsStopConfirmation/, 'the socket-table owner lookup and consent grant are gone')
})

test('Stop never asks for confirmation and never kills an unidentified port owner', () => {
  const actions = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(actions, /Stop and kill the port owner/)
  assert.doesNotMatch(actions, /manager\.stop\([^)]*,/)
  assert.match(runtimeSource(), /no DSH server for this instance could be identified/, 'an unidentified port owner is reported, not killed')
})

test('runtime delegates spawn, health, profile and process handling to their own modules', () => {
  const source = runtimeSource()
  for (const module of ['spawn', 'health', 'profile', 'process', 'log-pump']) {
    assert.match(source, new RegExp(`from '\\./${module}\\.ts'`), `runtime must use ./${module}.ts`)
  }
  assert.doesNotMatch(source, /function readLogTail\(/, 'the duplicated tail reader must not come back')
  assert.doesNotMatch(source, /function readTokenFromLog\(/, 'the duplicated token reader must not come back')
})

test('log tail reads live in the shared helpers and the live pump outside them', () => {
  const pump = readFileSync(new URL('../src/instances/runtime/log-pump.ts', import.meta.url), 'utf8')
  assert.match(pump, /from '\.\.\/\.\.\/shared\/logs\.ts'/)
  const logs = readFileSync(new URL('../src/shared/logs.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(logs, /class LogTailPump/, 'the live pump belongs to the instance runtime, not the pure log helpers')
})
