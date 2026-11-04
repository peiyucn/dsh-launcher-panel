import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseVersion } from '../src/dsh/release-tags.ts'

test('releaseVersion strips only the official dsh-v prefix', () => {
  assert.equal(releaseVersion('dsh-v0.1.7-alpha.1'), '0.1.7-alpha.1')
  assert.equal(releaseVersion('dsh-v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(releaseVersion('other-tag'), 'other-tag')
})
