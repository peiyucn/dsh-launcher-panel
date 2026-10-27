import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { bootstrapInstances, type InstanceBootstrapHost } from '../src/instance-bootstrap.ts'
import type { DshInstance, InstanceModelOptions } from '../src/instances.ts'

const homeDir = path.resolve('instance-bootstrap-test-home')
const options: InstanceModelOptions = {
  homeDir,
  defaultHome: path.join(homeDir, '.dsh'),
}

interface Recorder extends InstanceBootstrapHost {
  persisted: number
  marked: number
  persistedList: readonly DshInstance[] | undefined
}

function recorder(overrides: Partial<InstanceBootstrapHost> = {}): Recorder {
  const rec: Recorder = {
    persisted: 0,
    marked: 0,
    persistedList: undefined,
    readPersisted: () => ({ instances: undefined, activeId: undefined, legacyPort: 3080 }),
    isListAuthoritative: () => false,
    async persist(instances) {
      rec.persisted += 1
      rec.persistedList = instances
    },
    async markAuthoritative() {
      rec.marked += 1
    },
    ...overrides,
  }
  return rec
}

test('a failed settings write still yields the Default instance plus a visible warning', async () => {
  const failing = recorder({
    async persist() {
      throw new Error('Unable to write to User Settings because dsh.instances is not a registered configuration.')
    },
  })
  const result = await bootstrapInstances(failing, options)

  assert.deepEqual(result.instances.map((instance) => instance.id), ['default'])
  assert.equal(result.activeId, 'default')
  assert.equal(result.instances[0]?.home, path.resolve(options.defaultHome))
  assert.equal(failing.marked, 0, 'a list that was not persisted must not be marked authoritative')

  const warning = result.issues.find((issue) => issue.severity === 'warning')
  assert.ok(warning, 'the failed save must be surfaced as an issue')
  assert.match(warning.message, /not a registered configuration/u)
  assert.match(warning.message, /reload the window/u, 'the warning must name the fix')
})

test('a first run persists the synthesized list and marks it authoritative', async () => {
  const ok = recorder()
  const result = await bootstrapInstances(ok, options)

  assert.deepEqual(result.instances.map((instance) => instance.id), ['default'])
  assert.deepEqual(result.issues, [])
  assert.equal(ok.persisted, 1)
  assert.equal(ok.marked, 1)
  assert.equal(ok.persistedList?.[0]?.home, '', 'the stored Default keeps "default home" instead of pinning a path')
})

test('an existing list is returned untouched and is never re-written', async () => {
  const existing = recorder({
    readPersisted: () => ({
      instances: [{ id: 'one', name: 'One', home: '', profile: 'web', port: 3080 }],
      activeId: 'one',
      legacyPort: 3080,
    }),
  })
  const result = await bootstrapInstances(existing, options)

  assert.deepEqual(result.instances.map((instance) => instance.id), ['one'])
  assert.equal(result.activeId, 'one')
  assert.equal(existing.persisted, 0)
  assert.equal(existing.marked, 0)
})

test('a deliberately emptied list is not resurrected and not written', async () => {
  const emptied = recorder({ isListAuthoritative: () => true })
  const result = await bootstrapInstances(emptied, options)

  assert.deepEqual(result.instances, [])
  assert.equal(emptied.persisted, 0)
})
