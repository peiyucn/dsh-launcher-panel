import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProfileInitSpec,
  buildSpawnSpec,
  type ProfileInitSpecInput,
  type SpawnSpecInput,
} from '../src/dsh/start-spec.ts'

const baseEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', KEEP: 'yes' }

function pkgInput(overrides: Partial<SpawnSpecInput> = {}): SpawnSpecInput {
  return {
    mode: 'pnpm',
    version: '0.3.3',
    // process.execPath resolves to itself on every platform (only .cmd/.bat
    // shims are expanded by resolveCommandEntry), so this stays portable.
    pnpmCmd: process.execPath,
    installDir: '/managed/pkg',
    profile: 'web',
    port: 31001,
    home: '/instances/work',
    nodePath: '',
    sourceDebug: false,
    baseEnv,
    ...overrides,
  }
}

function sourceInput(overrides: Partial<SpawnSpecInput> = {}): SpawnSpecInput {
  return {
    mode: 'source',
    version: '0.1.7-alpha.1',
    checkout: '/src/deepseek-harness',
    profile: 'web',
    port: 31002,
    home: '/instances/work',
    nodePath: '',
    sourceDebug: false,
    baseEnv,
    ...overrides,
  }
}

function initInput(overrides: Partial<ProfileInitSpecInput> = {}): ProfileInitSpecInput {
  return {
    mode: 'pnpm',
    pnpmCmd: process.execPath,
    installDir: '/managed/pkg',
    profile: 'web',
    home: '/instances/work',
    nodePath: '',
    baseEnv,
    ...overrides,
  }
}

test('pkg mode spawns pnpm exec dsh with port, profile, DSH_HOME and --no-open', () => {
  const built = buildSpawnSpec(pkgInput())
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.spec.file, process.execPath)
  assert.deepEqual(built.spec.args, [
    '--config.verify-deps-before-run=false',
    'exec',
    'dsh',
    'web',
    '--port',
    '31001',
    '--no-open',
  ])
  assert.equal(built.spec.cwd, '/managed/pkg')
  assert.equal(built.spec.env.DSH_HOME, '/instances/work')
  assert.equal(built.spec.env.PATH, '/usr/bin')
  assert.equal(built.spec.env.KEEP, 'yes')
})

test('--no-open is gated on the dsh version', () => {
  const old = buildSpawnSpec(pkgInput({ version: '0.1.0-rc.7' }))
  assert.equal(old.ok, true)
  if (old.ok) assert.ok(!old.spec.args.includes('--no-open'))
  const unknown = buildSpawnSpec(pkgInput({ version: '' }))
  assert.equal(unknown.ok, true)
  if (unknown.ok) assert.ok(!unknown.spec.args.includes('--no-open'))
})

test('the base environment passed in is not mutated', () => {
  buildSpawnSpec(pkgInput())
  assert.equal(baseEnv.DSH_HOME, undefined)
})

test('source mode runs the checkout CLI through tsx with the configured node', () => {
  const built = buildSpawnSpec(sourceInput({ profile: 'work', sourceDebug: true }))
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.spec.file, 'node')
  assert.deepEqual(built.spec.args, [
    '--import',
    'tsx/esm',
    'apps/cli/src/bin.ts',
    'work',
    '--port',
    '31002',
    '--no-open',
  ])
  assert.equal(built.spec.cwd, '/src/deepseek-harness')
  assert.equal(built.spec.env.DSH_HOME, '/instances/work')
  assert.equal(built.spec.env.NODE_DEBUG, 'module')

  const configured = buildSpawnSpec(sourceInput({ nodePath: '/opt/node/bin/node' }))
  assert.equal(configured.ok, true)
  if (configured.ok) assert.equal(configured.spec.file, '/opt/node/bin/node')
})

test('NODE_DEBUG is only set for sourceDebug in source mode', () => {
  const source = buildSpawnSpec(sourceInput({ sourceDebug: false }))
  assert.equal(source.ok, true)
  if (source.ok) assert.equal(source.spec.env.NODE_DEBUG, undefined)

  const pkg = buildSpawnSpec(pkgInput({ sourceDebug: true }))
  assert.equal(pkg.ok, true)
  if (pkg.ok) assert.equal(pkg.spec.env.NODE_DEBUG, undefined)
})

test('missing shared-install parts are reported instead of spawning', () => {
  const noPnpm = buildSpawnSpec(pkgInput({ pnpmCmd: undefined }))
  assert.deepEqual(noPnpm, { ok: false, reason: 'pkg start has no pnpm install' })

  const noCheckout = buildSpawnSpec(sourceInput({ checkout: undefined }))
  assert.deepEqual(noCheckout, { ok: false, reason: 'source start has no checkout' })

  const noInitPnpm = buildProfileInitSpec(initInput({ installDir: undefined }))
  assert.deepEqual(noInitPnpm, { ok: false, reason: 'profile initialization needs a pnpm install' })

  const noInitCheckout = buildProfileInitSpec({
    mode: 'source',
    checkout: undefined,
    profile: 'web',
    home: '/instances/work',
    nodePath: '',
  })
  assert.deepEqual(noInitCheckout, { ok: false, reason: 'profile initialization needs a source checkout' })
})

test('an unreadable Windows pnpm shim is reported with its reason', { skip: process.platform !== 'win32' }, () => {
  const built = buildSpawnSpec(pkgInput({ pnpmCmd: 'C:\\missing\\pnpm.cmd' }))
  assert.equal(built.ok, false)
  if (!built.ok) assert.match(built.reason, /^pnpm cannot be launched \(/)
})

test('profile initialization composes the web profile via --dump-config', () => {
  const built = buildProfileInitSpec(initInput())
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.spec.file, process.execPath)
  assert.deepEqual(built.spec.args, [
    '--config.verify-deps-before-run=false',
    'exec',
    'dsh',
    'web',
    '--dump-config',
  ])
  assert.equal(built.spec.cwd, '/managed/pkg')
  assert.equal(built.spec.env.DSH_HOME, '/instances/work')
})

test('profile initialization creates a custom profile from the web template', () => {
  const built = buildProfileInitSpec({
    mode: 'source',
    checkout: '/src/deepseek-harness',
    profile: 'work',
    home: '/instances/work',
    nodePath: '/opt/node/bin/node',
    baseEnv,
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.spec.file, '/opt/node/bin/node')
  assert.deepEqual(built.spec.args, [
    '--import',
    'tsx/esm',
    'apps/cli/src/bin.ts',
    '--profile',
    'work',
    '--from-default-profile',
    'web',
    '--dump-config',
  ])
  assert.equal(built.spec.cwd, '/src/deepseek-harness')
  // Profile init is a one-shot compose; it never enables the debug flood.
  assert.equal(built.spec.env.NODE_DEBUG, undefined)
})
