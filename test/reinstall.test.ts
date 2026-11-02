import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanReinstall, type CleanReinstallHost } from '../src/dsh/reinstall.ts'
import { DSH_INSTALL_MANIFEST_NAME, writeInstallManifest } from '../src/dsh/paths.ts'

function makeInstall(root: string, version: string): string {
  const dir = join(root, 'pkg')
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), version)
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(dir, 'node_modules', 'stale-hardlink-marker.txt'), 'old')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'old lockfile')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'old workspace')
  assert.equal(writeInstallManifest(version, dir, 'hardlink'), true)
  return dir
}

function host(
  dir: string,
  installVersion: string | undefined,
  activities: string[],
): CleanReinstallHost {
  return {
    addActivity: (line) => { activities.push(line); return 0 },
    runInstalling: (task) => task(),
    runInTerminal: async () => {
      if (installVersion === undefined) return false
      mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: installVersion }))
      writeFileSync(join(dir, 'node_modules', 'fresh-copy-marker.txt'), 'new')
      return true
    },
  }
}

test('cleanReinstall moves stale install state aside and drops it after a successful install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-reinstall-'))
  try {
    const dir = makeInstall(root, '0.3.7')
    const activities: string[] = []
    const ok = await cleanReinstall('0.3.8', dir, 'pnpm', false, 'copy', host(dir, '0.3.8', activities))
    assert.equal(ok, true)
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-copy-marker.txt')), true)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-hardlink-marker.txt')), false, 'old node_modules is gone')
    assert.equal(existsSync(join(dir, 'node_modules.launcher-backup')), false, 'backup is cleaned up')
    assert.equal(existsSync(join(dir, 'pnpm-lock.yaml.launcher-backup')), false)
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

test('cleanReinstall restores the previous install when the reinstall fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-reinstall-fail-'))
  try {
    const dir = makeInstall(root, '0.3.7')
    const activities: string[] = []
    const ok = await cleanReinstall('0.3.8', dir, 'pnpm', false, 'copy', host(dir, undefined, activities))
    assert.equal(ok, false)
    assert.equal(existsSync(join(dir, 'node_modules', 'stale-hardlink-marker.txt')), true, 'previous install is restored')
    assert.equal(existsSync(join(dir, 'node_modules', 'fresh-copy-marker.txt')), false)
    assert.equal(existsSync(join(dir, 'node_modules.launcher-backup')), false)
    assert.equal(existsSync(join(dir, 'pnpm-lock.yaml')), true)
    assert.match(activities.join('\n'), /previous install was restored/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
