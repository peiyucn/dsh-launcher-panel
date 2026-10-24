import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  INSTANCE_BRAND_PACKAGE,
  ensureInstanceBrand,
  instanceBrandDir,
  removeInstanceBrand,
} from '../src/server/instance-brand.ts'

function makeProfile(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-instance-brand-'))
  const profile = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2), 'utf8')
  return home
}

function readManifest(home: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'))
}

test('ensureInstanceBrand writes a local bundle and adds it to the profile', () => {
  const home = makeProfile()
  try {
    const ok = ensureInstanceBrand(home, 'web', 'sssden')
    assert.equal(ok, true)
    const dir = instanceBrandDir(home, 'web')
    assert.ok(fs.existsSync(path.join(dir, 'package.json')))
    assert.ok(fs.existsSync(path.join(dir, 'cordis.patch.yml')))
    assert.ok(fs.existsSync(path.join(dir, 'lib', 'index.js')))
    const client = fs.readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8')
    assert.ok(client.includes('var INSTANCE_NAME = "sssden"'))
    assert.ok(client.includes('launcher-instance-line'))
    assert.ok(client.includes('_logoRow'))
    assert.ok(client.includes('locale/change'))
    const manifest = readManifest(home)
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      INSTANCE_BRAND_PACKAGE,
    ])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('ensureInstanceBrand is idempotent and updates the name in place', () => {
  const home = makeProfile()
  try {
    ensureInstanceBrand(home, 'web', 'one')
    ensureInstanceBrand(home, 'web', 'two')
    const manifest = readManifest(home)
    assert.equal(manifest.dsh.profile.bundles.filter((item: string) => item === INSTANCE_BRAND_PACKAGE).length, 1)
    const client = fs.readFileSync(path.join(instanceBrandDir(home, 'web'), 'lib', 'client.js'), 'utf8')
    assert.ok(client.includes('var INSTANCE_NAME = "two"'))
    assert.ok(!client.includes('var INSTANCE_NAME = "one"'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('removeInstanceBrand removes the bundle entry and generated files', () => {
  const home = makeProfile()
  try {
    ensureInstanceBrand(home, 'web', 'sssden')
    removeInstanceBrand(home, 'web')
    assert.equal(fs.existsSync(instanceBrandDir(home, 'web')), false)
    const manifest = readManifest(home)
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('ensureInstanceBrand skips a profile that has not been initialized', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-instance-brand-'))
  try {
    assert.equal(ensureInstanceBrand(home, 'web', 'sssden'), false)
    assert.equal(fs.existsSync(instanceBrandDir(home, 'web')), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('instance names are JSON-escaped in generated client code', () => {
  const home = makeProfile()
  try {
    ensureInstanceBrand(home, 'web', 'a "quoted" instance')
    const client = fs.readFileSync(path.join(instanceBrandDir(home, 'web'), 'lib', 'client.js'), 'utf8')
    assert.ok(client.includes(`var INSTANCE_NAME = ${JSON.stringify('a "quoted" instance')}`))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
