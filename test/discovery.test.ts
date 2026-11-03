import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectedName, detectDshServers } from '../src/instances/discovery.ts'
import type { ProcessEntry } from '../src/instances/process-list.ts'

test('detected names use the profile, defaulting to the port form', () => {
  assert.equal(detectedName('superagent', 3082), 'superagent')
  assert.equal(detectedName('web', 3080), 'dsh :3080')
  assert.equal(detectedName('', 3080), 'dsh :3080')
})

test('detectDshServers excludes configured ports, duplicate ports and other pids', async () => {
  const entries: ProcessEntry[] = [
    { pid: 10, command: 'node /usr/local/bin/dsh superagent --port 3082 --no-open' },
    { pid: 11, command: 'node /usr/local/bin/dsh web --port 3080 --no-open' },
    { pid: 12, command: 'node /usr/local/bin/dsh dup --port 3082 --no-open' },
    { pid: 13, command: 'node /usr/local/bin/dsh other --port 3099 --no-open' },
    { pid: 14, command: 'node unrelated.js --port 3082' },
    { pid: 15, command: 'node /usr/local/bin/dsh excluded --port 3100 --no-open' },
  ]
  const detected = await detectDshServers(new Set([3080]), new Set([15]), {
    list: async () => entries,
    portOpen: async (port) => port !== 3099,
    homeOf: (pid) => (pid === 10 ? '/home/agent/.dsh-superagent' : ''),
  })
  assert.deepEqual(detected.map((entry) => entry.port), [3082])
  assert.equal(detected[0]?.pid, 10)
  assert.equal(detected[0]?.profile, 'superagent')
  assert.equal(detected[0]?.home, '/home/agent/.dsh-superagent')
})
