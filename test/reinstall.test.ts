import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stagedReinstall, type ReinstallHost } from '../src/dsh/reinstall.ts'
import { DSH_INSTALL_MANIFEST_NAME, writeInstallManifest } from '../src/dsh/paths.ts'

const VERSION = '0.3.8'

function makeLiveInstall(root: string): string {
  const dir = join(root, 'package')
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.3.7' }))
  writeFileSync(join(dir, 'node_modules', 'stale-marker.txt'), 'old')
  assert.equal(writeInstallManifest('0.3.7', dir, 'hardlink'), true)
  return dir
}

function fakeInstall(dir: string, marker: string): void {
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: VERSION }))
  writeFileSync(join(dir, 'node_modules', marker), 'new')
}

function host(dir: string, behaviour: { preflight?: boolean; final?: boolean }): ReinstallHost {
  return {
    addActivity: () => 0,
    runInstalling: (task) => task(),
    runInTerminal: async (_title, _command, args) => {
      const target = args[args.indexOf('--dir') + 1]
      if (target.endsWith('.next')) {
        if (behaviour.preflight === false) return false
        fakeInstall(target, 'staged-marker.txt')
        return true
      }
      assert.equal(target, dir)
      if (behaviour.final === false) return false
      fakeInstall(target, 'fresh-marker.txt')
      return true
    },
  }
}

test('stagedReinstall verifies in staging, rebuilds at the final path and swaps successfully', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reinstall-'))
  try {
    const dir = makeLiveInstall(root)
    const ok = await stagedReinstall(VERSION, dir, 'pnpm', false, 'copy', host(dir, {}))
    assert.equal(ok, true)
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-marker.txt')), true)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), false)
    assert.equal(existsSync(`${dir}.next`), false, 'staging folder is cleaned up')
    assert.equal(existsSync(`${dir}.prev`), false, 'previous install is cleaned up')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      dshLauncher?: { packageImportMethod?: string }
    }
    assert.equal(manifest.name, DSH_INSTALL_MANIFEST_NAME)
    assert.equal(manifest.dshLauncher?.packageImportMethod, 'copy')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed preflight build leaves the live install untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reinstall-preflight-'))
  try {
    const dir = makeLiveInstall(root)
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const ok = await stagedReinstall(VERSION, dir, 'pnpm', false, 'copy', host(dir, { preflight: false }))
    assert.equal(ok, false)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true)
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-marker.txt')), false)
    assert.equal(existsSync(`${dir}.next`), false)
    assert.equal(existsSync(`${dir}.prev`), false)
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed final install restores the previous install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reinstall-final-'))
  try {
    const dir = makeLiveInstall(root)
    const ok = await stagedReinstall(VERSION, dir, 'pnpm', false, 'copy', host(dir, { final: false }))
    assert.equal(ok, false)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true, 'previous install restored')
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-marker.txt')), false)
    assert.equal(existsSync(`${dir}.next`), false)
    assert.equal(existsSync(`${dir}.prev`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
