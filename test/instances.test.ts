import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import {
  DEFAULT_PROFILE,
  instanceHome,
  instanceLogPath,
  isNestedHome,
  migrateLegacyInstance,
  nextPort,
  normalizeHome,
  normalizeInstances,
  resolveInitialInstances,
  sameHome,
  validateInstance,
  type DshInstance,
  type InstanceModelOptions,
} from '../src/instances.ts'

const homeDir = path.resolve('instances-test-home')
const options: InstanceModelOptions = {
  homeDir,
  defaultHome: path.join(homeDir, '.dsh'),
}

function instance(overrides: Partial<DshInstance> = {}): DshInstance {
  return {
    id: 'one',
    name: 'One',
    home: '',
    profile: DEFAULT_PROFILE,
    port: 3080,
    ...overrides,
  }
}

test('normalizeInstances accepts a valid list and resolves empty homes to the default', () => {
  const result = normalizeInstances(
    [{ id: 'one', name: 'One', home: '', profile: 'web', port: 3080 }],
    'one',
    options,
  )
  assert.deepEqual(result.issues, [])
  assert.equal(result.activeId, 'one')
  assert.equal(result.instances.length, 1)
  assert.equal(result.instances[0]?.home, path.resolve(options.defaultHome))
})

test('normalizeInstances reports an empty active id when it is unknown', () => {
  const result = normalizeInstances([instance()], 'missing', options)
  assert.equal(result.activeId, '')
})

test('normalizeInstances skips malformed entries and keeps the rest', () => {
  const result = normalizeInstances(
    [
      { id: 'one', name: 'One', home: '', profile: 'web', port: 3080 },
      { id: 'two', name: '', home: '', profile: 'web', port: 3081 },
      { id: 'three', name: 'Three', home: 'relative', profile: 'web', port: 3082 },
    ],
    undefined,
    options,
  )
  assert.deepEqual(result.instances.map((entry) => entry.id), ['one'])
  assert.equal(result.issues.filter((entry) => entry.severity === 'error').length, 2)
})

test('normalizeInstances treats a non-array value as a visible error', () => {
  const result = normalizeInstances('nope', undefined, options)
  assert.deepEqual(result.instances, [])
  assert.equal(result.issues[0]?.field, 'entry')
  assert.equal(result.issues[0]?.severity, 'error')
})

test('normalizeInstances warns about duplicate ports and shared homes', () => {
  const result = normalizeInstances(
    [
      { id: 'one', name: 'One', home: '', profile: 'web', port: 3080 },
      { id: 'two', name: 'Two', home: '', profile: 'web', port: 3080 },
    ],
    undefined,
    options,
  )
  assert.equal(result.instances.length, 2)
  assert.ok(result.issues.some((entry) => entry.field === 'port' && entry.severity === 'warning'))
  assert.ok(result.issues.some((entry) => entry.field === 'home' && entry.severity === 'warning'))
})

test('normalizeInstances rejects duplicate ids and duplicate names', () => {
  const result = normalizeInstances(
    [
      { id: 'one', name: 'One', home: '', profile: 'web', port: 3080 },
      { id: 'one', name: 'Other', home: '', profile: 'web', port: 3081 },
      { id: 'two', name: 'one', home: '', profile: 'web', port: 3082 },
    ],
    undefined,
    options,
  )
  assert.deepEqual(result.instances.map((entry) => entry.id), ['one'])
  assert.equal(result.issues.filter((entry) => entry.field === 'id' && entry.severity === 'error').length, 1)
  assert.equal(result.issues.filter((entry) => entry.field === 'name' && entry.severity === 'error').length, 1)
})

test('normalizeHome expands ~ and rejects relative paths', () => {
  assert.equal(normalizeHome('~', options), path.resolve(homeDir))
  assert.equal(normalizeHome('~/foo', options), path.resolve(path.join(homeDir, 'foo')))
  assert.equal(normalizeHome('', options), path.resolve(options.defaultHome))
  assert.equal(normalizeHome('relative/path', options), undefined)
})

test('normalizeHome rejects homes inside a forbidden root', () => {
  const forbidden = path.join(homeDir, '.dsh-launcher-panel')
  const result = normalizeInstances(
    [{ id: 'one', name: 'One', home: path.join(forbidden, 'instance'), profile: 'web', port: 3080 }],
    undefined,
    { ...options, forbiddenHomes: [forbidden] },
  )
  assert.deepEqual(result.instances, [])
  assert.equal(result.issues[0]?.field, 'home')
})

test('migrateLegacyInstance carries the old port and defaults the rest', () => {
  const migrated = migrateLegacyInstance(3099)
  assert.deepEqual(migrated, { id: 'default', name: 'Default', home: '', profile: 'web', port: 3099 })
  assert.equal(migrateLegacyInstance('nope').port, 3080)
  assert.equal(migrateLegacyInstance(70000).port, 3080)
})

test('nextPort skips used ports and starts at the requested port', () => {
  assert.equal(nextPort(new Set([3080, 3081])), 3082)
  assert.equal(nextPort(new Set([3080]), 3080), 3081)
  assert.equal(nextPort(new Set([1]), 1), 2)
  assert.equal(nextPort(new Set(), 65535), 65535)
  assert.equal(nextPort(new Set([65535]), 65535), undefined)
})

test('validateInstance creates an instance and rejects duplicates', () => {
  const existing = [instance({ id: 'old', name: 'Old', port: 3080 })]
  const created = validateInstance(
    { name: 'New', home: path.join(homeDir, 'new'), profile: 'web', port: 3081 },
    options,
    existing,
    undefined,
    () => 'generated',
  )
  assert.deepEqual(created.issues, [])
  assert.equal(created.instance?.id, 'generated')

  const duplicate = validateInstance(
    { name: 'Old', home: path.join(homeDir, 'new'), profile: 'web', port: 3080 },
    options,
    existing,
  )
  assert.equal(duplicate.instance, undefined)
  assert.ok(duplicate.issues.some((entry) => entry.field === 'name'))
  assert.ok(duplicate.issues.some((entry) => entry.field === 'port'))
})

test('validateInstance allows editing the instance being edited', () => {
  const existing = [instance({ id: 'one', name: 'One', port: 3080 })]
  const result = validateInstance(
    { name: 'One', home: '', profile: 'web', port: 3080 },
    options,
    existing,
    'one',
  )
  assert.deepEqual(result.issues, [])
  assert.equal(result.instance?.id, 'one')
})

test('validateInstance warns when the home is shared with another instance', () => {
  const existing = [instance({ id: 'one', name: 'One', port: 3080 })]
  const result = validateInstance(
    { name: 'Two', home: '', profile: 'web', port: 3081 },
    options,
    existing,
  )
  assert.ok(result.instance !== undefined)
  assert.ok(result.issues.some((entry) => entry.field === 'home' && entry.severity === 'warning'))
})

test('sameHome and isNestedHome compare normalized directories', () => {
  assert.equal(sameHome(path.join(homeDir, 'a'), path.join(homeDir, 'a')), true)
  assert.equal(sameHome(path.join(homeDir, 'a'), path.join(homeDir, 'b')), false)
  assert.equal(isNestedHome(homeDir, path.join(homeDir, 'child')), true)
  assert.equal(isNestedHome(homeDir, homeDir), false)
  assert.equal(isNestedHome(homeDir, path.join(homeDir, '..', 'other')), false)
})

test('resolveInitialInstances synthesizes the legacy Default on a first run', () => {
  const result = resolveInitialInstances(undefined, undefined, 3099, false, options)
  assert.equal(result.synthesized, true)
  assert.deepEqual(result.instances.map((entry) => entry.id), ['default'])
  assert.equal(result.instances[0]?.name, 'Default')
  assert.equal(result.instances[0]?.port, 3099)
  assert.equal(result.instances[0]?.home, path.resolve(options.defaultHome))
  assert.equal(result.activeId, 'default')
  assert.deepEqual(result.issues, [])
  assert.equal(result.stored[0]?.home, '', 'the persisted Default keeps "default home" rather than a pinned path')
})

test('resolveInitialInstances keeps an existing list and does not synthesize', () => {
  const result = resolveInitialInstances(
    [{ id: 'one', name: 'One', home: '', profile: 'web', port: 3080 }],
    'one',
    3099,
    false,
    options,
  )
  assert.equal(result.synthesized, false)
  assert.deepEqual(result.instances.map((entry) => entry.id), ['one'])
  assert.equal(result.activeId, 'one')
})

test('resolveInitialInstances does not resurrect a list the user emptied on purpose', () => {
  const result = resolveInitialInstances([], '', 3099, true, options)
  assert.equal(result.synthesized, false)
  assert.deepEqual(result.instances, [])
  assert.deepEqual(result.issues, [])
})

test('resolveInitialInstances keeps normalization issues and still offers the Default', () => {
  const result = resolveInitialInstances([{ id: 'broken' }], undefined, 3099, false, options)
  assert.equal(result.synthesized, true)
  assert.deepEqual(result.instances.map((entry) => entry.id), ['default'])
  assert.ok(result.issues.some((entry) => entry.severity === 'error'))
})

test('instanceHome resolves the effective home and instanceLogPath uses the id', () => {
  assert.equal(instanceHome(instance(), options), path.resolve(options.defaultHome))
  assert.equal(instanceHome(instance({ home: path.join(homeDir, 'custom') }), options), path.resolve(path.join(homeDir, 'custom')))
  assert.equal(instanceLogPath(path.join(homeDir, '.dsh-launcher-panel'), 'abc'), path.join(homeDir, '.dsh-launcher-panel', 'logs', 'instances', 'abc', 'server.log'))
})
