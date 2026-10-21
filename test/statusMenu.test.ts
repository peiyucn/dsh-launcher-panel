import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusMenuItems, buildStatusMenuSummary } from '../src/statusMenu.ts'

const base = { running: false, starting: false, installing: false, stopping: false, updating: false }
const actions = (status: typeof base) => buildStatusMenuItems(status).map((item) => item.action)

const summaryBase = {
  ...base,
  dshVersion: '0.1.2-alpha.1',
  mode: 'pnpm' as const,
  url: 'http://127.0.0.1:3080',
}

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

test('updating status menu does not offer start', () => {
  // An update rewrites the checkout / package tree; the server refuses a start
  // while one runs, so the menu must not offer it either.
  assert.deepEqual(actions({ ...base, updating: true }), ['dashboard', 'settings'])
})

test('every menu item carries a label and a codicon id', () => {
  for (const item of buildStatusMenuItems({ ...base, running: true })) {
    assert.ok(item.label.length > 0)
    assert.ok(item.icon.length > 0)
  }
})

test('status menu summary reports state, mode, version and endpoint', () => {
  assert.equal(
    buildStatusMenuSummary({ ...summaryBase, running: true }),
    'Running · pkg mode · dsh v0.1.2-alpha.1 · 127.0.0.1:3080',
  )
  // The endpoint is only a fact while the server is up.
  assert.equal(buildStatusMenuSummary(summaryBase), 'Stopped · pkg mode · dsh v0.1.2-alpha.1')
})

test('status menu summary follows the in-flight states and the source mode', () => {
  assert.equal(buildStatusMenuSummary({ ...summaryBase, starting: true }), 'Starting · pkg mode · dsh v0.1.2-alpha.1')
  assert.equal(buildStatusMenuSummary({ ...summaryBase, installing: true }), 'Installing · pkg mode · dsh v0.1.2-alpha.1')
  assert.equal(buildStatusMenuSummary({ ...summaryBase, updating: true }), 'Updating · pkg mode · dsh v0.1.2-alpha.1')
  assert.equal(buildStatusMenuSummary({ ...summaryBase, stopping: true }), 'Stopping · pkg mode · dsh v0.1.2-alpha.1')
  assert.equal(buildStatusMenuSummary({ ...summaryBase, mode: 'source' }), 'Stopped · src mode · dsh v0.1.2-alpha.1')
})

test('status menu summary says when the dsh version is unknown', () => {
  assert.equal(buildStatusMenuSummary({ ...summaryBase, dshVersion: '' }), 'Stopped · pkg mode · dsh version unknown')
})