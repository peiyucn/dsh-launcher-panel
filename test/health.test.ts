import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForReady, type ReadyHooks } from '../src/instances/runtime/health.ts'
import { PORT_POLL_INTERVAL_MS } from '../src/shared/timing.ts'

function hooks(overrides: Partial<ReadyHooks> = {}): ReadyHooks {
  return {
    state: () => 'starting',
    pid: () => undefined,
    logPath: () => '',
    legacyLogPath: () => '',
    activity: () => {},
    fail: () => false,
    transition: () => {},
    setUrl: () => {},
    killTracked: () => {},
    ...overrides,
  }
}

test('waitForReady probes immediately, without sleeping before the first attempt', async () => {
  const waits: number[] = []
  let probes = 0
  const ok = await waitForReady(3080, hooks(), {
    probeUrl: async () => { probes += 1; return 'http://127.0.0.1:3080/' },
    sleep: async (ms) => { waits.push(ms) },
  })
  assert.equal(ok, true)
  assert.equal(probes, 1)
  assert.deepEqual(waits, [], 'the first probe must not wait for a poll interval')
})

test('waitForReady backs off exactly one poll interval before retrying a miss', async () => {
  const waits: number[] = []
  let probes = 0
  const ok = await waitForReady(3080, hooks(), {
    probeUrl: async () => (++probes === 1 ? undefined : 'http://127.0.0.1:3080/'),
    sleep: async (ms) => { waits.push(ms) },
  })
  assert.equal(ok, true)
  assert.equal(probes, 2)
  assert.deepEqual(waits, [PORT_POLL_INTERVAL_MS])
})

test('waitForReady never probes once the instance has left the starting state', async () => {
  let probes = 0
  const ok = await waitForReady(3080, hooks({ state: () => 'stopping' }), {
    probeUrl: async () => { probes += 1; return undefined },
    sleep: async () => {},
  })
  assert.equal(ok, false)
  assert.equal(probes, 0)
})

test('waitForReady reports a failed start instead of probing a dead process', async () => {
  const failed: string[] = []
  const ok = await waitForReady(3080, hooks({
    pid: () => 999999999,
    fail: (message) => { failed.push(message); return false },
  }), {
    probeUrl: async () => undefined,
    sleep: async () => {},
  })
  assert.equal(ok, false)
  assert.equal(failed.length, 1)
  assert.match(failed[0], /exited before opening port/)
})
