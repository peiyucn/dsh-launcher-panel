import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUILD_CLEAN_SCRIPT, BUILD_OFFICIAL_SCRIPT, CLIENT_BUILD_RECORD_REL, DSH_BUILD_PROFILE_OFFICIAL, DSH_CLIENT_BUILD_PROFILE_KEY, DSH_INSTALL_MANIFEST_NAME, canTransition, checkoutHasOfficialBrand, checkoutSupportsClean, checkoutSupportsOfficialBuild, describeDshUpdate, dshBaseDir, dshVersionAtLeast, extractWebToken, installedDshVersion, isDshCheckout, isDshInstallDirUsable, isProcessAlive, maskPath, pnpmSupportsDangerouslyAllowAllBuilds, psQuote, quoteCmdArg, resolveDshHome, toEnglish, windowsPnpmCandidates } from '../src/common.ts'

test('canTransition allows only valid server phase transitions', () => {
  assert.equal(canTransition('stopped', 'starting'), true)
  assert.equal(canTransition('starting', 'installing'), true)
  assert.equal(canTransition('installing', 'starting'), true)
  assert.equal(canTransition('installing', 'stopping'), true)
  assert.equal(canTransition('installing', 'stopped'), true)
  assert.equal(canTransition('starting', 'running'), true)
  assert.equal(canTransition('starting', 'stopping'), true)
  assert.equal(canTransition('starting', 'stopped'), true)
  assert.equal(canTransition('running', 'stopping'), true)
  assert.equal(canTransition('stopping', 'stopped'), true)
  assert.equal(canTransition('stopped', 'installing'), false)
  assert.equal(canTransition('installing', 'running'), false)
  assert.equal(canTransition('stopped', 'running'), false)
  assert.equal(canTransition('running', 'starting'), false)
  assert.equal(canTransition('running', 'stopped'), false)
  assert.equal(canTransition('stopped', 'stopping'), false)
})

test('dshVersionAtLeast compares prerelease versions numerically', () => {
  assert.equal(dshVersionAtLeast('0.1.0-rc.8', '0.1.0-rc.8'), true)
  assert.equal(dshVersionAtLeast('0.1.0-rc.10', '0.1.0-rc.8'), true)
  assert.equal(dshVersionAtLeast('0.1.0-rc.7', '0.1.0-rc.8'), false)
  assert.equal(dshVersionAtLeast('', '0.1.0-rc.8'), false)
  assert.equal(dshVersionAtLeast('0.2.0', '0.1.0-rc.8'), true)
})

test('describeDshUpdate distinguishes update, failure, and up-to-date', () => {
  assert.equal(describeDshUpdate({ hasUpdate: true, label: 'v0.2.0' }), '✓ Update available → v0.2.0')
  assert.equal(describeDshUpdate({ hasUpdate: false, label: '', failed: true }), '⚠ Update check failed')
  assert.equal(describeDshUpdate({ hasUpdate: false, label: '' }), '✓ dsh is up to date')
  assert.equal(describeDshUpdate(undefined), '✓ dsh is up to date')
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

test('quoteCmdArg quotes args containing special characters', () => {
  assert.equal(quoteCmdArg('a b'), '"a b"')
  assert.equal(quoteCmdArg('a&b'), '"a&b"')
  assert.equal(quoteCmdArg('a|b'), '"a|b"')
})

test('quoteCmdArg leaves plain args unquoted', () => {
  assert.equal(quoteCmdArg('plain'), 'plain')
})

test('psQuote doubles single quotes', () => {
  assert.equal(psQuote("it's"), "it''s")
  assert.equal(psQuote('plain'), 'plain')
})

test('toEnglish strips non-ASCII and parentheticals', () => {
  assert.equal(toEnglish('DeepSeek V3 Chat API（对话）'), 'DeepSeek V3 Chat API')
  assert.equal(toEnglish('全是中文'), '')
})

test('extractWebToken reads the token from dsh web startup output', () => {
  assert.equal(extractWebToken('dsh web: http://127.0.0.1:3080/?token=e9FDDvp1cDfkePv9wnWBMCJLPOjzoi7qLaSIQghrElE'), 'e9FDDvp1cDfkePv9wnWBMCJLPOjzoi7qLaSIQghrElE')
  assert.equal(extractWebToken('dsh web: http://127.0.0.1:3080'), undefined)
  assert.equal(extractWebToken('token=abc'), undefined)
  assert.equal(extractWebToken(''), undefined)
})

test('isProcessAlive reports own pid alive and an impossible pid dead', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999999999), false)
})

test('dshBaseDir resolves the home directory on every platform', () => {
  assert.equal(dshBaseDir('win32', { USERPROFILE: 'C:\\Users\\me' }, 'C:\\Users\\me'), join('C:\\Users\\me', '.dsh-launcher-panel'))
  assert.equal(dshBaseDir('win32', {}, 'C:\\Users\\me'), join('C:\\Users\\me', '.dsh-launcher-panel'))
  assert.equal(dshBaseDir('darwin', {}, '/Users/me'), join('/Users/me', '.dsh-launcher-panel'))
  assert.equal(dshBaseDir('linux', {}, '/home/me'), join('/home/me', '.dsh-launcher-panel'))
})

test('isDshCheckout recognises a checkout root and the cli package', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-checkout-'))
  try {
    assert.equal(isDshCheckout(join(root, 'absent')), false)
    assert.equal(isDshCheckout(undefined), false)
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(repo, 'apps', 'cli', 'src', 'bin.ts'), '')
    assert.equal(isDshCheckout(repo), true)
    assert.equal(isDshCheckout(join(repo, 'apps', 'cli')), true)
    const other = join(root, 'other')
    mkdirSync(join(other, 'src'), { recursive: true })
    writeFileSync(join(other, 'src', 'bin.ts'), '')
    assert.equal(isDshCheckout(other), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pnpmSupportsDangerouslyAllowAllBuilds gates on pnpm 10.16+', () => {
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('11.22.0'), true)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('10.16.0'), true)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('10.15.0'), false)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds('9.15.4'), false)
  assert.equal(pnpmSupportsDangerouslyAllowAllBuilds(''), false)
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

test('windowsPnpmCandidates lists the npm-global and pnpm shims', () => {
  const out = windowsPnpmCandidates({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
  assert.deepEqual(out, [
    join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'pnpm.cmd'),
    join('C:\\Users\\me\\AppData\\Local', 'pnpm', 'pnpm.cmd'),
  ])
  assert.deepEqual(windowsPnpmCandidates({}), [])
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
