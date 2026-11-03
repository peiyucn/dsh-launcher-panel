import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import {
  clearObservedInstallCache,
  findDshPackageJson,
  resolveObservedInstall,
} from '../src/instances/observed-info.ts'
import type { ProcessEntry } from '../src/instances/discovery.ts'

const DSP_VERSION = '0.2.1-rc.5'
const DSP_ROOT = path.join('/usr/local/lib/node_modules/@deepseek-ai/dsh')
const DSP_PKG = path.join(DSP_ROOT, 'package.json')
const DSP_ENTRY = path.join(DSP_ROOT, 'lib', 'bin.js')

function files(map: Record<string, string>) {
  return {
    realpath: (file: string) => file,
    readFile: (file: string) => map[file],
  }
}

test('findDshPackageJson walks up from the entry to the dsh package.json', () => {
  const found = findDshPackageJson(DSP_ENTRY, files({
    [DSP_PKG]: JSON.stringify({ name: '@deepseek-ai/dsh', version: DSP_VERSION }),
  }))
  assert.deepEqual(found, { packagePath: DSP_ROOT, version: DSP_VERSION })
})

test('findDshPackageJson skips unrelated package.jsons', () => {
  const cliPkg = path.join('/x/apps/cli/package.json')
  const rootPkg = path.join('/x/package.json')
  const found = findDshPackageJson(path.join('/x/apps/cli/src/bin.ts'), files({
    [cliPkg]: JSON.stringify({ name: 'cli-helper', version: '9.9.9' }),
    [rootPkg]: JSON.stringify({ name: 'deepseek-harness', version: '0.2.1' }),
  }))
  assert.deepEqual(found, { packagePath: path.join('/x'), version: '0.2.1' })
})

test('resolveObservedInstall reports package path, version and command', async () => {
  clearObservedInstallCache()
  const shim = path.join('/usr/local/bin/dsh')
  const entries: ProcessEntry[] = [
    { pid: 701, command: `node ${shim} superagent --port 3082 --no-open` },
  ]
  const info = await resolveObservedInstall(3082, {
    list: async () => entries,
    realpath: (file) => (file === shim ? DSP_ENTRY : file),
    readFile: (file) => (file === DSP_PKG ? JSON.stringify({ name: '@deepseek-ai/dsh', version: DSP_VERSION }) : undefined),
  })
  assert.equal(info.version, DSP_VERSION)
  assert.equal(info.packagePath, DSP_ROOT)
  assert.equal(info.entryPath, shim)
  assert.match(info.command ?? '', /--port 3082/)
  clearObservedInstallCache()
})

test('resolveObservedInstall returns an empty object when no process serves the port', async () => {
  clearObservedInstallCache()
  const info = await resolveObservedInstall(3999, { list: async () => [] })
  assert.deepEqual(info, {})
  clearObservedInstallCache()
})
