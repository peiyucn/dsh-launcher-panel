import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverInterruptedReinstall, reinstallInPlace, type ReinstallHost } from '../src/dsh/reinstall.ts'
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

function host(dir: string, behaviour: { fail?: boolean; breakLive?: boolean } = {}): { host: ReinstallHost; activities: string[] } {
  const activities: string[] = []
  return {
    activities,
    host: {
      addActivity: (line) => { activities.push(line); return 0 },
      runInstalling: (task) => task(),
      runInTerminal: async () => {
        if (behaviour.fail) {
          if (behaviour.breakLive) rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
          return false
        }
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
        writeTree(dir, VERSION, 'fresh-marker.txt')
        return true
      },
    },
  }
}

function assertClean(dir: string): void {
  assert.equal(existsSync(`${dir}.next`), false, 'no staging leftover')
  assert.equal(existsSync(`${dir}.prev`), false, 'no previous-install leftover')
  assert.equal(existsSync(`${dir}.launcher-lock`), false, 'no lock leftover')
}

test('reinstallInPlace rebuilds the same folder in place and keeps the manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inplace-'))
  try {
    const dir = makeLiveInstall(root)
    const { host: h, activities } = host(dir)
    assert.equal(await reinstallInPlace(VERSION, dir, 'pnpm', false, 'copy', h), true)
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-marker.txt')), true)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), false)
    assertClean(dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      dshLauncher?: { packageImportMethod?: string }
    }
    assert.equal(manifest.name, DSH_INSTALL_MANIFEST_NAME)
    assert.equal(manifest.dshLauncher?.packageImportMethod, 'copy')
    assert.doesNotMatch(activities.join('\n'), /delete .*package/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed reinstall reports the delete-folder recovery instruction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inplace-fail-'))
  try {
    const dir = makeLiveInstall(root)
    const { host: h, activities } = host(dir, { fail: true, breakLive: true })
    assert.equal(await reinstallInPlace(VERSION, dir, 'pnpm', false, 'copy', h), false)
    assert.match(activities.join('\n'), /delete .*package.*Start again/)
    assertClean(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('switching the import method back and forth repeatedly stays clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inplace-toggle-'))
  try {
    const dir = makeLiveInstall(root)
    for (const method of ['copy', 'hardlink', 'copy', 'hardlink', 'copy', 'hardlink'] as const) {
      const { host: h } = host(dir)
      assert.equal(await reinstallInPlace(VERSION, dir, 'pnpm', false, method, h), true, `switch to ${method}`)
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

test('a stale pnpm-workspace.yaml is set aside during the reinstall and dropped on success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inplace-workspace-'))
  try {
    const dir = makeLiveInstall(root)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    const { host: h } = host(dir)
    assert.equal(await reinstallInPlace(VERSION, dir, 'pnpm', false, 'copy', h), true)
    assert.equal(existsSync(join(dir, 'pnpm-workspace.yaml')), false)
    assert.equal(existsSync(join(dir, 'pnpm-workspace.yaml.prev')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverInterruptedReinstall converges leftovers from older rename-based versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inplace-recover-'))
  try {
    const dir = makeLiveInstall(root)
    writeTree(`${dir}.prev`, '0.3.6', 'older-marker.txt')
    mkdirSync(`${dir}.next`, { recursive: true })
    writeFileSync(`${dir}.launcher-lock`, 'stale')
    recoverInterruptedReinstall(dir)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true)
    assert.equal(existsSync(`${dir}.prev`), false)
    assert.equal(existsSync(`${dir}.next`), false)
    assert.equal(existsSync(`${dir}.launcher-lock`), true, 'the lock is left for acquireLock to judge')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a concurrent reinstall is skipped while the lock is fresh, and stale locks expire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inplace-lock-'))
  try {
    const dir = makeLiveInstall(root)
    const lock = `${dir}.launcher-lock`
    writeFileSync(lock, 'other-window')
    const { host: blocked } = host(dir)
    assert.equal(await reinstallInPlace(VERSION, dir, 'pnpm', false, 'copy', blocked), false)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true)

    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(lock, old, old)
    const { host: allowed } = host(dir)
    assert.equal(await reinstallInPlace(VERSION, dir, 'pnpm', false, 'copy', allowed), true)
    assertClean(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
