import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTakeoverInfo } from '../src/instances/takeover-info.ts'
import type { DshInstance } from '../src/instances/model.ts'

const observed: DshInstance = {
  id: 'ecs',
  name: 'Superagent ECS',
  home: '',
  profile: 'superagent',
  port: 3082,
  observed: true,
}

test('takeover info carries the detected facts without any token', () => {
  const info = buildTakeoverInfo(observed, { command: 'node /usr/local/bin/dsh superagent --port 3082 --no-open' })
  assert.match(info, /Instance: Superagent ECS/)
  assert.match(info, /DSH_HOME: \(unknown — ask the user\)/)
  assert.match(info, /Profile: superagent/)
  assert.match(info, /Port: 3082/)
  assert.match(info, /node \/usr\/local\/bin\/dsh superagent --port 3082 --no-open/)
  assert.match(info, /read-only/)
  assert.doesNotMatch(info, /token=/i)
})

test('takeover info states the safety constraints for the agent', () => {
  const info = buildTakeoverInfo(observed)
  assert.match(info, /Never print, copy or persist launch tokens/)
  assert.match(info, /Ask the user before any irreversible change/)
  assert.match(info, /Keep DSH_HOME, profile and port unchanged/)
})

test('takeover info includes a known home', () => {
  const info = buildTakeoverInfo({ ...observed, home: '/home/agent/.dsh-superagent' })
  assert.match(info, /DSH_HOME: \/home\/agent\/\.dsh-superagent/)
})
