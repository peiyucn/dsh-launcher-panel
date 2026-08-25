import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusMenuItems } from '../src/statusMenu.ts'

const base = { running: false, starting: false, installing: false, stopping: false }
const actions = (status: typeof base) => buildStatusMenuItems(status).map((item) => item.action)

test('stopped status menu offers start first, then dashboard', () => {
  assert.deepEqual(actions(base), ['start', 'dashboard', 'settings'])
})

test('running status menu offers open, dashboard and stop', () => {
  assert.deepEqual(actions({ ...base, running: true }), ['open', 'dashboard', 'stop', 'settings'])
})

test('starting or installing status menu offers dashboard and stop', () => {
  assert.deepEqual(actions({ ...base, starting: true }), ['dashboard', 'stop', 'settings'])
  assert.deepEqual(actions({ ...base, installing: true }), ['dashboard', 'stop', 'settings'])
})

test('stopping status menu offers dashboard only', () => {
  assert.deepEqual(actions({ ...base, stopping: true }), ['dashboard', 'settings'])
})

test('every menu item carries a label and a codicon id', () => {
  for (const item of buildStatusMenuItems({ ...base, running: true })) {
    assert.ok(item.label.length > 0)
    assert.ok(item.icon.length > 0)
  }
})