import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stagedReinstall, type ReinstallHost } from '../src/dsh/reinstall.ts'
import { DSH_INSTALL_MANIFEST_NAME, writeInstallManifest } from '../src/dsh/paths.ts'

function makeLiveInstall(root: string): string {
  const dir = join(root, 'package')
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.3.7' }))
  writeFileSync(join(dir, 'node_modules', 'stale-marker.txt'), 'old')
  assert.equal(writeInstallManifest('0.3.7', dir, 'hardlink'), true)
  return dir
}

function hostFor(result: 'ok' | 'fail'): ReinstallHost {
  return {
    addActivity: () => 0,
    runInstalling: (task) => task(),
    runInTerminal: async (_title, _command, args) => {
      const staging = args[args.indexOf('--dir') + 1]
      assert.match(staging, /\.next$/)
      if (result === 'fail') return false
      mkdirSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
      writeFileSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.3.7' }))
      writeFileSync(join(staging, 'node_modules', 'fresh-marker.txt'), 'new')
      return true
    },
  }
}

test('stagedReinstall builds in a staging folder and swaps it in on success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-staged-'))
  try {
    const dir = makeLiveInstall(root)
    const ok = await stagedReinstall('0.3.7', dir, 'pnpm', false, 'copy', hostFor('ok'))
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

test('stagedReinstall leaves the live install untouched when the build fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-staged-fail-'))
  try {
    const dir = makeLiveInstall(root)
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const ok = await stagedReinstall('0.3.7', dir, 'pnpm', false, 'copy', hostFor('fail'))
    assert.equal(ok, false)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-marker.txt')), true, 'live install untouched')
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-marker.txt')), false)
    assert.equal(existsSync(`${dir}.next`), false)
    assert.equal(existsSync(`${dir}.prev`), false)
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before, 'live manifest untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
