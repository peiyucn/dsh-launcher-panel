import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  BUILD_CLEAN_SCRIPT,
  BUILD_OFFICIAL_SCRIPT,
  CLIENT_BUILD_RECORD_REL,
  DSH_BUILD_PROFILE_OFFICIAL,
  DSH_CLIENT_BUILD_PROFILE_KEY,
  DSH_CLIENT_COMMIT_HASH,
  DSH_INSTALL_MANIFEST_NAME,
  checkoutDepsStale,
  checkoutHasOfficialBrand,
  checkoutReady,
  checkoutSupportsClean,
  checkoutSupportsOfficialBuild,
  clientBuildCommit,
  dshBaseDir,
  driveRootExists,
  installedDshVersion,
  isDshCheckout,
  installManifestRepairable,
  isDshInstallDirUsable,
  maskPath,
  resolveDshHome,
  writeInstallManifest,
} from '../src/dsh/paths.ts'

test('dshBaseDir resolves the home directory on every platform', () => {
  assert.equal(dshBaseDir('win32', { USERPROFILE: 'C:\\Users\\me' }, 'C:\\Users\\me'), join('C:\\Users\\me', '.dsh-launcher-panel'))
  assert.equal(dshBaseDir('win32', {}, 'C:\\Users\\me'), join('C:\\Users\\me', '.dsh-launcher-panel'))
  assert.equal(dshBaseDir('darwin', {}, '/Users/me'), join('/Users/me', '.dsh-launcher-panel'))
  assert.equal(dshBaseDir('linux', {}, '/home/me'), join('/home/me', '.dsh-launcher-panel'))
})

test('resolveDshHome prefers DSH_HOME and falls back to ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\custom\\dsh'
  assert.equal(resolveDshHome(), 'C:\\custom\\dsh')
  delete process.env.DSH_HOME
  assert.ok(resolveDshHome().endsWith('.dsh'))
  if (prev === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prev
})

test('isDshCheckout recognises a checkout root and the cli package', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-'))
  try {
    assert.equal(isDshCheckout(undefined), false)
    assert.equal(isDshCheckout(join(root, 'absent')), false)
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(repo, 'apps', 'cli', 'src', 'bin.ts'), '')
    assert.equal(isDshCheckout(repo), true)
    assert.equal(isDshCheckout(join(repo, 'apps', 'cli')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isDshCheckout normalizes trailing separators and surrounding whitespace', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-normalize-'))
  try {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(repo, 'apps', 'cli', 'src', 'bin.ts'), '')
    const cli = join(repo, 'apps', 'cli')

    assert.equal(isDshCheckout(repo + sep), true, 'checkout root with a trailing separator')
    assert.equal(isDshCheckout(cli + sep), true, 'cli package with a trailing separator')
    assert.equal(isDshCheckout(cli + sep + sep), true, 'cli package with repeated trailing separators')
    const forwardSlashes = repo.split(sep).join('/')
    assert.equal(isDshCheckout(forwardSlashes + '/'), true, 'checkout root with forward slashes')
    assert.equal(isDshCheckout(`  ${repo}${sep}  `), true, 'path padded with whitespace')
    assert.equal(isDshCheckout('   '), false, 'whitespace-only value')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isDshCheckout accepts spaces and non-ASCII in the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-u-'))
  try {
    const repo = join(root, 'repo 空格 检查 dir')
    mkdirSync(join(repo, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(repo, 'apps', 'cli', 'src', 'bin.ts'), '')
    assert.equal(isDshCheckout(repo), true)
    assert.equal(isDshCheckout(join(repo, 'apps', 'cli') + sep), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isDshCheckout resolves a relative path against the cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-rel-'))
  try {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(repo, 'apps', 'cli', 'src', 'bin.ts'), '')
    const relativePath = relative(process.cwd(), repo)
    if (!isAbsolute(relativePath)) {
      assert.equal(isDshCheckout(relativePath), true, `relative checkout path ${relativePath}`)
      assert.equal(isDshCheckout(join(relativePath, 'apps', 'cli') + sep), true, 'relative cli path')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('isDshCheckout rejects directories and files that are not a checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-not-checkout-'))
  try {
    const other = join(root, 'other')
    mkdirSync(join(other, 'src'), { recursive: true })
    writeFileSync(join(other, 'src', 'bin.ts'), '')
    assert.equal(isDshCheckout(other), false)
    const notCli = join(root, 'apps', 'app')
    mkdirSync(join(notCli, 'src'), { recursive: true })
    writeFileSync(join(notCli, 'src', 'bin.ts'), '')
    assert.equal(isDshCheckout(notCli), false)
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    assert.equal(isDshCheckout(empty), false)
    const file = join(root, 'file.txt')
    writeFileSync(file, '')
    assert.equal(isDshCheckout(file), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installedDshVersion reads the managed install version', () => {
  const root = join(tmpdir(), 'dsh-install-test-' + process.pid)
  try {
    const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }))
    assert.equal(installedDshVersion(root), '0.1.1-rc.2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installedDshVersion returns undefined when absent', () => {
  assert.equal(installedDshVersion(join(tmpdir(), 'dsh-install-none-' + process.pid)), undefined)
})

test('isDshInstallDirUsable accepts absent, empty and launcher-owned dirs only', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usable-'))
  try {
    assert.equal(isDshInstallDirUsable(join(root, 'absent')), true)
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    assert.equal(isDshInstallDirUsable(empty), true)
    const owned = join(root, 'owned')
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'package.json'), JSON.stringify({ name: DSH_INSTALL_MANIFEST_NAME }))
    assert.equal(isDshInstallDirUsable(owned), true)
    const foreign = join(root, 'foreign')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'my-project' }))
    assert.equal(isDshInstallDirUsable(foreign), false)
    const dataOnly = join(root, 'data')
    mkdirSync(dataOnly, { recursive: true })
    writeFileSync(join(dataOnly, 'note.txt'), 'x')
    assert.equal(isDshInstallDirUsable(dataOnly), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A folder can be a usable install target while its package.json belongs to the user: "usable"
// must not imply "writable", which is what the writer's ownership guard has to prevent.
test('a usable install dir can still have a package.json the launcher must not touch', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ownership-'))
  try {
    const dir = join(root, 'user-project-with-dsh')
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(
      join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }),
    )
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'my-web-app',
      version: '3.1.4',
      scripts: { build: 'vite build' },
      dependencies: { express: '^4.21.0' },
    }))

    assert.equal(isDshInstallDirUsable(dir), true, 'the install itself may proceed')
    assert.equal(installManifestRepairable(dir), false, 'but its package.json must not be replaced')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installManifestRepairable accepts only absent or launcher-owned manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manifest-'))
  try {
    assert.equal(installManifestRepairable(join(root, 'absent')), true)
    const owned = join(root, 'owned')
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'package.json'), JSON.stringify({ name: DSH_INSTALL_MANIFEST_NAME, private: true }))
    assert.equal(installManifestRepairable(owned), true)
    const foreign = join(root, 'foreign')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'my-project' }))
    assert.equal(installManifestRepairable(foreign), false)
    const corrupt = join(root, 'corrupt')
    mkdirSync(corrupt, { recursive: true })
    writeFileSync(join(corrupt, 'package.json'), '{ not json')
    assert.equal(installManifestRepairable(corrupt), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeInstallManifest never replaces a package.json it does not own', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-write-'))
  try {
    const dir = join(root, 'user-project')
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(
      join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }),
    )
    const userManifest = {
      name: 'my-web-app',
      version: '3.1.4',
      scripts: { build: 'vite build', test: 'vitest' },
      dependencies: { express: '^4.21.0' },
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(userManifest, null, 2))

    assert.equal(isDshInstallDirUsable(dir), true)
    assert.equal(writeInstallManifest('0.1.7-rc.2', dir), false)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), userManifest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeInstallManifest writes into an absent or launcher-owned dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-write-ok-'))
  try {
    const fresh = join(root, 'fresh')
    assert.equal(writeInstallManifest('0.1.7-rc.2', fresh), true)
    assert.equal(JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8')).name, DSH_INSTALL_MANIFEST_NAME)
    assert.equal(writeInstallManifest('0.1.7-rc.3', fresh), true)
    assert.equal(
      JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'],
      '0.1.7-rc.3',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkoutSupportsOfficialBuild detects the build:official script', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-brand-supports-'))
  try {
    assert.equal(checkoutSupportsOfficialBuild(root), false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsx scripts/build.ts' } }))
    assert.equal(checkoutSupportsOfficialBuild(root), false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsx scripts/build.ts', [BUILD_OFFICIAL_SCRIPT]: 'tsx scripts/build.ts --profile official' } }))
    assert.equal(checkoutSupportsOfficialBuild(root), true)
    writeFileSync(join(root, 'package.json'), '{not json')
    assert.equal(checkoutSupportsOfficialBuild(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkoutSupportsClean detects the clean script', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-supports-'))
  try {
    assert.equal(checkoutSupportsClean(root), false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsx scripts/build.ts' } }))
    assert.equal(checkoutSupportsClean(root), false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsx scripts/build.ts', [BUILD_CLEAN_SCRIPT]: 'tsx scripts/clean.ts' } }))
    assert.equal(checkoutSupportsClean(root), true)
    writeFileSync(join(root, 'package.json'), '{not json')
    assert.equal(checkoutSupportsClean(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkoutHasOfficialBrand reads the build record profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-brand-record-'))
  try {
    assert.equal(checkoutHasOfficialBrand(root), false)
    const record = join(root, CLIENT_BUILD_RECORD_REL)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, JSON.stringify({ environment: { DSH_CLIENT_COMMIT_HASH: 'b150a55' } }))
    assert.equal(checkoutHasOfficialBrand(root), false)
    writeFileSync(record, JSON.stringify({ environment: { DSH_CLIENT_COMMIT_HASH: 'b150a55', [DSH_CLIENT_BUILD_PROFILE_KEY]: DSH_BUILD_PROFILE_OFFICIAL } }))
    assert.equal(checkoutHasOfficialBrand(root), true)
    writeFileSync(record, '{not json')
    assert.equal(checkoutHasOfficialBrand(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clientBuildCommit reads the built commit from the build record', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-commit-'))
  try {
    assert.equal(clientBuildCommit(root), undefined)
    const record = join(root, CLIENT_BUILD_RECORD_REL)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, JSON.stringify({ environment: { DSH_CLIENT_COMMIT_HASH: 'db6bdc3' } }))
    assert.equal(clientBuildCommit(root), 'db6bdc3')
    writeFileSync(record, JSON.stringify({ environment: {} }))
    assert.equal(clientBuildCommit(root), undefined)
    writeFileSync(record, '{not json')
    assert.equal(clientBuildCommit(root), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('maskPath abbreviates long Windows paths to drive + last segment', () => {
  assert.equal(maskPath('C:\\Users\\me\\dsh-launcher-panel.log'), 'C:\\…\\dsh-launcher-panel.log')
})

test('maskPath abbreviates long Unix paths', () => {
  assert.equal(maskPath('/home/me/project/x.log'), '…/x.log')
})

test('maskPath leaves short paths intact', () => {
  assert.equal(maskPath('C:\\a\\b'), 'C:\\a\\b')
})

test('maskPath returns empty for empty input', () => {
  assert.equal(maskPath(''), '')
})

test('checkoutReady accepts either tsx install layout and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ready-'))
  try {
    assert.equal(checkoutReady(root), false)
    mkdirSync(join(root, 'node_modules', 'tsx'), { recursive: true })
    assert.equal(checkoutReady(root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const root2 = mkdtempSync(join(tmpdir(), 'dsh-ready2-'))
  try {
    mkdirSync(join(root2, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(root2, 'node_modules', '.bin', 'tsx'), '')
    assert.equal(checkoutReady(root2), true)
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})

test('checkoutDepsStale compares the lockfile against the install record', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stale-'))
  try {
    assert.equal(checkoutDepsStale(root), false)

    const record = join(root, 'node_modules', '.pnpm', 'lock.yaml')
    const lock = join(root, 'pnpm-lock.yaml')
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, 'installed')
    assert.equal(checkoutDepsStale(root), false)

    writeFileSync(lock, 'lock')
    const installedAt = new Date(Date.now() - 60_000)
    const lockAt = new Date(Date.now() - 120_000)
    utimesSync(record, installedAt, installedAt)
    utimesSync(lock, lockAt, lockAt)
    assert.equal(checkoutDepsStale(root), false)

    const newer = new Date(Date.now())
    utimesSync(lock, newer, newer)
    assert.equal(checkoutDepsStale(root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('driveRootExists accepts a reachable location and never probes a UNC root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-drive-'))
  try {
    assert.equal(driveRootExists(join(root, 'package')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(driveRootExists('\\\\dsh-test-server\\share\\package'), true)
})
