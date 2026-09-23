import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUILD_CLEAN_SCRIPT, BUILD_OFFICIAL_SCRIPT, CLIENT_BUILD_RECORD_REL, DEFAULT_BROWSER, DSH_BUILD_PROFILE_OFFICIAL, DSH_CLI_ENTRY_GUARD_MIN_VERSION, DSH_CLIENT_BUILD_PROFILE_KEY, DSH_CLIENT_COMMIT_HASH, DSH_INSTALL_MANIFEST_NAME, canTransition, checkoutHasOfficialBrand, checkoutSupportsClean, checkoutSupportsOfficialBuild, clientBuildCommit, compareDshVersions, decideSourceUpdate, describeDshUpdate, dshBaseDir, dshVersionAtLeast, dshVersionFromDescribe, extractWebToken, installedDshVersion, isDshCheckout, isDshInstallDirUsable, isProcessAlive, maskPath, newestDshVersion, newestReleaseTag, normalizeBrowser, npmSpecForChannel, parseImportMetaMainProbe, parseNpmChannel, parseRemoteReleaseTags, parseLocalProxySettings, pnpmSupportsDangerouslyAllowAllBuilds, psQuote, quoteCmdArg, resolveDshHome, runFile, shouldOpenBrowser, silentExitHint, toEnglish, versionFromDescribe, windowsPnpmCandidates } from '../src/common.ts'

test('normalizeBrowser collapses config values to known choices', () => {
  assert.equal(normalizeBrowser('external'), 'external')
  assert.equal(normalizeBrowser('built-in'), 'built-in')
  assert.equal(normalizeBrowser(undefined), DEFAULT_BROWSER)
  assert.equal(normalizeBrowser('garbage'), DEFAULT_BROWSER)
  assert.equal(normalizeBrowser(''), DEFAULT_BROWSER)
})

test('shouldOpenBrowser honours auto-open and explicit re-opens', () => {
  assert.equal(shouldOpenBrowser(undefined, false), true)
  assert.equal(shouldOpenBrowser(true, false), true)
  assert.equal(shouldOpenBrowser(false, false), false)
  assert.equal(shouldOpenBrowser(false, true), true)
  assert.equal(shouldOpenBrowser(undefined, true), true)
})

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

test('dshVersionAtLeast ranks a stable release above its own prereleases', () => {
  // The release-after-rc case: segment-by-segment comparison read the shorter
  // stable version as *older*, which hid every stable dsh release after an rc.
  assert.equal(dshVersionAtLeast('0.1.5', '0.1.5-rc.1'), true)
  assert.equal(dshVersionAtLeast('0.1.5-rc.1', '0.1.5'), false)
  assert.equal(dshVersionAtLeast('0.1.5', '0.1.5'), true)
  assert.equal(dshVersionAtLeast('0.1.5-rc.2', '0.1.5-rc.1'), true)
  assert.equal(dshVersionAtLeast(DSH_CLI_ENTRY_GUARD_MIN_VERSION, DSH_CLI_ENTRY_GUARD_MIN_VERSION), true)
  assert.equal(dshVersionAtLeast('0.1.3-alpha.1', DSH_CLI_ENTRY_GUARD_MIN_VERSION), false)
  assert.equal(dshVersionAtLeast('0.1.5-rc.1', DSH_CLI_ENTRY_GUARD_MIN_VERSION), true)
  assert.equal(dshVersionAtLeast('0.1.2-rc.1', DSH_CLI_ENTRY_GUARD_MIN_VERSION), false)
})

test('parseImportMetaMainProbe accepts only a true probe answer', () => {
  assert.equal(parseImportMetaMainProbe('true'), true)
  assert.equal(parseImportMetaMainProbe('true\r\n'), true)
  // Node < 22.18 / < 24.2 stringifies the missing binding as undefined.
  assert.equal(parseImportMetaMainProbe('undefined'), false)
  assert.equal(parseImportMetaMainProbe(''), false)
  assert.equal(parseImportMetaMainProbe('false'), false)
  assert.equal(parseImportMetaMainProbe('v24.0.0'), false)
})

test('silentExitHint explains only the guarded-entry silent exit', () => {
  const base = { dshVersion: '0.1.5-rc.1', nodeVersion: '24.0.0', supportsImportMetaMain: false, outputLines: 0 }
  const hint = silentExitHint(base)
  assert.ok(hint?.includes('import.meta.main'))
  assert.ok(hint?.includes('Node v24.0.0'))
  // A dsh older than the guard, captured output, or a capable Node: nothing to add.
  assert.equal(silentExitHint({ ...base, dshVersion: '0.1.2-rc.1' }), undefined)
  assert.equal(silentExitHint({ ...base, outputLines: 3 }), undefined)
  assert.equal(silentExitHint({ ...base, supportsImportMetaMain: true }), undefined)
  // An unknown version must not produce a claim about that version.
  assert.equal(silentExitHint({ ...base, dshVersion: '' }), undefined)
  assert.ok(silentExitHint({ ...base, nodeVersion: '' })?.includes('The configured Node'))
})

test('describeDshUpdate distinguishes update, failure, and up-to-date', () => {
  assert.equal(describeDshUpdate({ hasUpdate: true, label: 'v0.2.0' }), '✓ Update available → v0.2.0')
  assert.equal(describeDshUpdate({ hasUpdate: false, label: '', failed: true }), '⚠ Update check failed')
  assert.equal(describeDshUpdate({ hasUpdate: false, label: '' }), '✓ dsh is up to date')
  assert.equal(describeDshUpdate(undefined), '✓ dsh is up to date')
})

test('describeDshUpdate reports the underlying failure reason when captured', () => {
  assert.equal(
    describeDshUpdate({ hasUpdate: false, label: '', failed: true, failedReason: 'timed out after 10s' }),
    '⚠ Update check failed — timed out after 10s',
  )
  // An empty reason must not leave a dangling separator.
  assert.equal(describeDshUpdate({ hasUpdate: false, label: '', failed: true, failedReason: '' }), '⚠ Update check failed')
})

test('parseRemoteReleaseTags keeps only dsh release tags and reads their commits', () => {
  const stdout = [
    'aaa1111\trefs/tags/dsh-v0.1.5-rc.2',
    'bbb2222\trefs/tags/dsh-v0.1.7-alpha.1',
    'ccc3333\trefs/tags/dsh-v0.1.7-alpha.1^{}',
    'ddd4444\trefs/tags/some-other-tag',
    'eee5555\trefs/tags/dsh-vnot-a-version',
  ].join('\n')
  assert.deepEqual(parseRemoteReleaseTags(stdout), [
    { tag: 'dsh-v0.1.5-rc.2', commit: 'aaa1111' },
    { tag: 'dsh-v0.1.7-alpha.1', commit: 'ccc3333' },
  ])
})

test('parseRemoteReleaseTags prefers the peeled commit for annotated tags regardless of line order', () => {
  // The peeled line can precede the tag-object line in some transports.
  const peeledFirst = [
    'ccc3333\trefs/tags/dsh-v0.1.7-alpha.1^{}',
    'bbb2222\trefs/tags/dsh-v0.1.7-alpha.1',
  ].join('\n')
  assert.deepEqual(parseRemoteReleaseTags(peeledFirst), [{ tag: 'dsh-v0.1.7-alpha.1', commit: 'ccc3333' }])
})

test('parseRemoteReleaseTags tolerates empty and malformed output', () => {
  assert.deepEqual(parseRemoteReleaseTags(''), [])
  assert.deepEqual(parseRemoteReleaseTags('fatal: not a git repository\n'), [])
})

test('newestReleaseTag picks the newest tag and keeps its commit', () => {
  const tags = [
    { tag: 'dsh-v0.1.6-alpha.2', commit: 'aaa1111' },
    { tag: 'dsh-v0.1.7-alpha.1', commit: 'bbb2222' },
    { tag: 'dsh-v0.1.5-rc.2', commit: 'ccc3333' },
  ]
  assert.deepEqual(newestReleaseTag(tags), { tag: 'dsh-v0.1.7-alpha.1', commit: 'bbb2222' })
  assert.equal(newestReleaseTag([]), undefined)
})

test('decideSourceUpdate reports an unrecognized listing as failed, never "up to date"', () => {
  // `git ls-remote` can succeed while every tag it returned is a shape this
  // build cannot parse (SHA-256 origin, unexpected prerelease spelling, an
  // origin carrying no dsh-v* tag). Calling that "up to date" would pin the
  // panel to a silent lie — and to no Update button — forever.
  const failed = decideSourceUpdate(undefined, false)
  assert.equal(failed.hasUpdate, false)
  assert.equal(failed.failed, true)
  assert.equal(describeDshUpdate(failed), '⚠ Update check failed — origin lists no official dsh release tag')
})

test('decideSourceUpdate offers the newest tag only when HEAD does not contain it', () => {
  const newest = { tag: 'dsh-v0.1.7-rc.1', commit: 'abc1234' }
  assert.deepEqual(decideSourceUpdate(newest, false), { hasUpdate: true, label: 'v0.1.7-rc.1' })
  // HEAD sits on the tag or past it (e.g. master after the tag): updating would
  // move the checkout backwards.
  assert.deepEqual(decideSourceUpdate(newest, true), { hasUpdate: false, label: '' })
  assert.equal(describeDshUpdate(decideSourceUpdate(newest, true)), '✓ dsh is up to date')
})

test('parseLocalProxySettings reads the format git actually prints', () => {
  // 格式取自本机 git 2.55 的实际输出（`git config --global --get-regexp proxy`）。
  const real = 'http.proxy http://127.0.0.1:7897\nhttps.proxy http://127.0.0.1:7897'
  assert.deepEqual(parseLocalProxySettings(real), [
    { key: 'http.proxy', host: '127.0.0.1', port: 7897 },
    { key: 'https.proxy', host: '127.0.0.1', port: 7897 },
  ])
})

test('parseLocalProxySettings ignores non-loopback and malformed proxies', () => {
  // 远端代理不可达可能只是当前网络位置问题，不该由我们断言。
  assert.deepEqual(parseLocalProxySettings('http.proxy http://proxy.corp.example:8080'), [])
  assert.deepEqual(parseLocalProxySettings('http.proxy http://127.0.0.1'), [])
  assert.deepEqual(parseLocalProxySettings('http.proxy not-a-url'), [])
  assert.deepEqual(parseLocalProxySettings('user.name someone'), [])
  assert.deepEqual(parseLocalProxySettings(''), [])
})

test('parseLocalProxySettings accepts localhost and IPv6 loopback', () => {
  assert.deepEqual(parseLocalProxySettings('http.proxy http://localhost:7890'), [
    { key: 'http.proxy', host: 'localhost', port: 7890 },
  ])
  assert.deepEqual(parseLocalProxySettings('http.proxy http://[::1]:7890'), [
    { key: 'http.proxy', host: '::1', port: 7890 },
  ])
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

test('parseNpmChannel normalizes channel settings', () => {
  assert.equal(parseNpmChannel('next'), 'next')
  assert.equal(parseNpmChannel('alpha'), 'alpha')
  assert.equal(parseNpmChannel('latest'), 'latest')
  assert.equal(parseNpmChannel(undefined), 'latest')
  assert.equal(parseNpmChannel('garbage'), 'latest')
})

test('npmSpecForChannel maps channels to npm specs', () => {
  assert.equal(npmSpecForChannel('latest'), '@deepseek-ai/dsh')
  assert.equal(npmSpecForChannel('next'), '@deepseek-ai/dsh@next')
  assert.equal(npmSpecForChannel('alpha'), '@deepseek-ai/dsh@alpha')
})

test('compareDshVersions orders versions by core, then prerelease', () => {
  assert.equal(compareDshVersions('0.1.2-rc.1', '0.1.2-rc.1'), 0)
  assert.equal(compareDshVersions('0.1.2', '0.1.2-rc.1'), 1)
  assert.equal(compareDshVersions('0.1.2-rc.1', '0.1.2'), -1)
  assert.equal(compareDshVersions('0.1.2-rc.1', '0.1.2-alpha.5'), 1)
  assert.equal(compareDshVersions('0.1.2-rc.2', '0.1.2-rc.10'), -1)
  assert.equal(compareDshVersions('0.1.10', '0.1.2'), 1)
  assert.equal(compareDshVersions('0.1.2-alpha.5', '0.1.1-rc.2'), 1)
})

test('newestDshVersion picks the newest of the list', () => {
  assert.equal(newestDshVersion(['0.1.2-alpha.5', '0.1.2-rc.1', '0.1.1-rc.2']), '0.1.2-rc.1')
  assert.equal(newestDshVersion(['0.1.2-rc.1', '0.1.2']), '0.1.2')
  assert.equal(newestDshVersion([]), undefined)
})

test('versionFromDescribe extracts the base version', () => {
  assert.equal(versionFromDescribe('dsh-v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('dsh-v0.1.2-rc.1-99-g76fda72'), '0.1.2-rc.1')
  // 规整后的写法（dshVersionFromDescribe 的产物）同样认得。
  assert.equal(versionFromDescribe('0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('0.1.2-rc.1-99-g76fda72'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('not-a-describe'), undefined)
})

test('dshVersionFromDescribe normalises the describe into a bare version', () => {
  assert.equal(dshVersionFromDescribe('dsh-v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(dshVersionFromDescribe('dsh-v0.1.2-rc.1-99-g76fda72'), '0.1.2-rc.1-99-g76fda72')
  assert.equal(dshVersionFromDescribe('dsh-v0.1.2-rc.1\n'), '0.1.2-rc.1')
  // 没有前缀的值原样返回（幂等）。
  assert.equal(dshVersionFromDescribe('0.1.2-rc.1'), '0.1.2-rc.1')
})

test('source-mode version row never doubles the v prefix', () => {
  // 面板渲染 = 'v' + 服务端值；服务端值里若还留着 v，面板就会显示 'vv0.1.5-rc.2'
  // （2026-09-13 本地测试实测到）。这条守住「服务端只给裸版本号」这个契约。
  assert.equal('v' + dshVersionFromDescribe('dsh-v0.1.5-rc.2'), 'v0.1.5-rc.2')
  assert.equal('v' + dshVersionFromDescribe('dsh-v0.1.2-rc.1-99-g76fda72'), 'v0.1.2-rc.1-99-g76fda72')
  // 与 pkg 模式（npm 版本号）拼出来的写法一致。
  assert.equal('v' + dshVersionFromDescribe('dsh-v0.1.5-rc.2'), 'v' + '0.1.5-rc.2')
})

test('runFile reports success with stdout and no error', async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stdout.write("hello")'])
  assert.equal(r.ok, true)
  assert.equal(r.stdout.trim(), 'hello')
  assert.equal(r.error, undefined)
  assert.equal(r.timedOut, undefined)
  assert.equal(r.code, undefined)
})

test('runFile keeps the exit code and last stderr line of a failed command', async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stderr.write("first\\nsecond\\n"); process.exit(3)'])
  assert.equal(r.ok, false)
  assert.equal(r.code, 3)
  assert.equal(r.timedOut, undefined)
  // The *last* line is the cause; earlier lines are usually context.
  assert.equal(r.error, 'second')
})

test('runFile marks a timeout as such instead of a bare failure', async () => {
  const r = await runFile(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], 600)
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(r.code, undefined)
  assert.match(r.error ?? '', /^timed out after 1s$/)
})

test('runFile reports a spawn failure with its reason', async () => {
  const r = await runFile('definitely-not-a-real-binary-xyz', [])
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, undefined)
  assert.equal(r.code, undefined)
  assert.ok((r.error ?? '').length > 0)
})
