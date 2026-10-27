import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareDshVersions,
  decideSourceUpdate,
  describeDshUpdate,
  dshVersionAtLeast,
  dshVersionFromDescribe,
  newestDshVersion,
  newestReleaseTag,
  parseRemoteReleaseTags,
  versionFromDescribe,
} from '../src/dsh/versions.ts'

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

test('dshVersionAtLeast compares prerelease versions numerically', () => {
  assert.equal(dshVersionAtLeast('0.1.0-rc.8', '0.1.0-rc.8'), true)
  assert.equal(dshVersionAtLeast('0.1.0-rc.10', '0.1.0-rc.8'), true)
  assert.equal(dshVersionAtLeast('0.1.0-rc.7', '0.1.0-rc.8'), false)
  assert.equal(dshVersionAtLeast('', '0.1.0-rc.8'), false)
  assert.equal(dshVersionAtLeast('0.2.0', '0.1.0-rc.8'), true)
})

test('dshVersionAtLeast ranks a stable release above its own prereleases', () => {
  assert.equal(dshVersionAtLeast('0.1.5', '0.1.5-rc.1'), true)
  assert.equal(dshVersionAtLeast('0.1.5-rc.1', '0.1.5'), false)
  assert.equal(dshVersionAtLeast('0.1.5', '0.1.5'), true)
  assert.equal(dshVersionAtLeast('0.1.5-rc.2', '0.1.5-rc.1'), true)
  assert.equal(dshVersionAtLeast('0.1.3-alpha.2', '0.1.3-alpha.2'), true)
  assert.equal(dshVersionAtLeast('0.1.3-alpha.1', '0.1.3-alpha.2'), false)
  assert.equal(dshVersionAtLeast('0.1.5-rc.1', '0.1.3-alpha.2'), true)
  assert.equal(dshVersionAtLeast('0.1.2-rc.1', '0.1.3-alpha.2'), false)
})

test('versionFromDescribe extracts the base version', () => {
  assert.equal(versionFromDescribe('dsh-v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('dsh-v0.1.2-rc.1-99-g76fda72'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('0.1.2-rc.1-99-g76fda72'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(versionFromDescribe('not-a-describe'), undefined)
})

test('dshVersionFromDescribe normalises the describe into a bare version', () => {
  assert.equal(dshVersionFromDescribe('dsh-v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(dshVersionFromDescribe('dsh-v0.1.2-rc.1-99-g76fda72'), '0.1.2-rc.1-99-g76fda72')
  assert.equal(dshVersionFromDescribe('dsh-v0.1.2-rc.1\n'), '0.1.2-rc.1')
  assert.equal(dshVersionFromDescribe('0.1.2-rc.1'), '0.1.2-rc.1')
})

test('source-mode version row never doubles the v prefix', () => {
  assert.equal('v' + dshVersionFromDescribe('dsh-v0.1.5-rc.2'), 'v0.1.5-rc.2')
  assert.equal('v' + dshVersionFromDescribe('dsh-v0.1.2-rc.1-99-g76fda72'), 'v0.1.2-rc.1-99-g76fda72')
  assert.equal('v' + dshVersionFromDescribe('dsh-v0.1.5-rc.2'), 'v' + '0.1.5-rc.2')
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
  const failed = decideSourceUpdate(undefined, false)
  assert.equal(failed.hasUpdate, false)
  assert.equal(failed.failed, true)
  assert.equal(describeDshUpdate(failed), '⚠ Update check failed — origin lists no official dsh release tag')
})

test('decideSourceUpdate offers the newest tag only when HEAD does not contain it', () => {
  const newest = { tag: 'dsh-v0.1.7-rc.1', commit: 'abc1234' }
  assert.deepEqual(decideSourceUpdate(newest, false), { hasUpdate: true, label: 'v0.1.7-rc.1' })
  assert.deepEqual(decideSourceUpdate(newest, true), { hasUpdate: false, label: '' })
  assert.equal(describeDshUpdate(decideSourceUpdate(newest, true)), '✓ dsh is up to date')
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
  assert.equal(describeDshUpdate({ hasUpdate: false, label: '', failed: true, failedReason: '' }), '⚠ Update check failed')
})
