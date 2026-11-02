import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverInterruptedReinstall, stagedReinstall, type ReinstallHost } from '../src/dsh/reinstall.ts'
import { DSH_INSTALL_MANIFEST_NAME, writeInstallManifest } from '../src/dsh/paths.ts'

const VERSION = '0.3.8'

function writeTree(dir: string, version: string, marker: string): void {
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'x')
  writeFileSync(join(dir, 'node_modules', marker), 'new')
}

function makeLiveInstall(root: string): string {
  const dir = join(root, 'package')
  writeTree(dir, '0.3.7', 'stale-marker.txt')
  assert.equal(writeInstallManifest('0.3.7', dir, 'hardlink'), true)
  return dir
}

function fakeInstall(dir: string, marker: string): void {
  writeTree(dir, VERSION, marker)
}

function host(dir: string, behaviour: { preflight?: boolean; final?: boolean; onFinal?: () => void } = {}): ReinstallHost {
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
      behaviour.onFinal?.()
      if (behaviour.final === false) return false
      fakeInstall(target, 'fresh-marker.txt')
      return true
    },
  }
}

function assertClean(dir: string): void {
  assert.equal(existsSync(`${dir}.next`), false, 'no staging leftover')
  assert.equal(existsSync(`${dir}.prev`), false, 'no previous-install leftover')
  assert.equal(existsSync(`${dir}.launcher-lock`), false, 'no lock leftover')
}

test('stagedReinstall verifies in staging, rebuilds at the final path and swaps successfully', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reinstall-'))
  try {
    const dir = makeLiveInstall(root)
    const ok = await stagedReinstall(VERSION, dir, 'pnpm', false, 'copy', host(dir))
    assert.equal(ok, true)
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-marker.txt')), true)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), false)
    assertClean(dir)
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
    assertClean(dir)
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
    assertClean(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('switching the import method back and forth repeatedly stays clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reinstall-toggle-'))
  try {
    const dir = makeLiveInstall(root)
    for (const method of ['copy', 'hardlink', 'copy', 'hardlink', 'copy', 'hardlink'] as const) {
      const ok = await stagedReinstall(VERSION, dir, 'pnpm', false, method, host(dir))
      assert.equal(ok, true, `switch to ${method} must succeed`)
      assertClean(dir)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dshLauncher?: { packageImportMethod?: string }
      }
      assert.equal(manifest.dshLauncher?.packageImportMethod, method)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverInterruptedReinstall restores the previous install when the live tree is broken', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recover-broken-'))
  try {
    const dir = join(root, 'package')
    mkdirSync(dir, { recursive: true })
    writeInstallManifest(VERSION, dir, 'copy') // partial live tree: manifest but no node_modules
    writeTree(`${dir}.prev`, '0.3.7', 'stale-marker.txt')
    recoverInterruptedReinstall(dir)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true)
    assertClean(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverInterruptedReinstall keeps a healthy live install and removes stale leftovers', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recover-healthy-'))
  try {
    const dir = makeLiveInstall(root)
    writeTree(`${dir}.prev`, '0.3.6', 'older-marker.txt')
    mkdirSync(`${dir}.next`, { recursive: true })
    recoverInterruptedReinstall(dir)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true)
    assert.equal(existsSync(`${dir}.prev`), false)
    assert.equal(existsSync(`${dir}.next`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a concurrent conversion is skipped while the lock is fresh, and stale locks expire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reinstall-lock-'))
  try {
    const dir = makeLiveInstall(root)
    const lock = `${dir}.launcher-lock`
    writeFileSync(lock, 'other-window')
    assert.equal(await stagedReinstall(VERSION, dir, 'pnpm', false, 'copy', host(dir)), false)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true, 'live install untouched while locked')

    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(lock, old, old)
    assert.equal(await stagedReinstall(VERSION, dir, 'pnpm', false, 'copy', host(dir)), true)
    assertClean(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
