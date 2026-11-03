import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import {
  clearObservedProcessCache,
  findDshPackageJson,
  resolveObservedProcess,
} from '../src/instances/observed-process.ts'
import type { ProcessEntry } from '../src/instances/process-list.ts'

const VERSION = '0.2.1-rc.5'
const TOKEN = 'AbCdEfGh12345678'
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
    [DSP_PKG]: JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }),
  }))
  assert.deepEqual(found, { packagePath: DSP_ROOT, version: VERSION })
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

test('resolveObservedProcess resolves pid, package, version and token in one pass', async () => {
  clearObservedProcessCache()
  const shim = path.join('/usr/local/bin/dsh')
  const entries: ProcessEntry[] = [
    { pid: 701, command: `node ${shim} superagent --port 3082 --no-open` },
  ]
  const info = await resolveObservedProcess(3082, {
    list: async () => entries,
    realpath: (file) => (file === shim ? DSP_ENTRY : file),
    readFile: (file) => (file === DSP_PKG ? JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }) : undefined),
    token: {
      platform: 'linux',
      readCgroup: () => '0::/system.slice/dsh-superagent.service',
      run: async () => ({ ok: true, stdout: `?token=${TOKEN}`, stderr: '' }),
    },
  })
  assert.equal(info.pid, 701)
  assert.equal(info.packagePath, DSP_ROOT)
  assert.equal(info.version, VERSION)
  assert.equal(info.token, TOKEN)
  clearObservedProcessCache()
})

test('resolveObservedProcess reports when no process serves the port', async () => {
  clearObservedProcessCache()
  const info = await resolveObservedProcess(3999, { list: async () => [] })
  assert.match(info.tokenError ?? '', /no dsh process is serving/)
  clearObservedProcessCache()
})
