/**
 * Tests for the pure helpers in `src/server/release-tags.ts`.
 *
 * The containment verdict is what decides whether the panel offers a dsh
 * update, and the update rewrites a source checkout: a probe that failed must
 * never be read as "not contained" (that offered an update on a git timeout and
 * could move the checkout backwards). The mapping is pure, so it is pinned here
 * without a repository.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyContainment, releaseVersion } from '../src/server/release-tags.ts'

test('a successful ancestor check means the commit is contained', () => {
  assert.equal(classifyContainment({ ok: true }), 'contained')
})

test('exit code 1 means the commit is not contained', () => {
  assert.equal(classifyContainment({ ok: false, code: 1 }), 'not-contained')
})

test('exit code 128 (unknown object, tag not fetched yet) means not contained', () => {
  // Update is the right next step when the tag has never been fetched; treating
  // this as "contained" would hide the update instead.
  assert.equal(classifyContainment({ ok: false, code: 128 }), 'not-contained')
})

test('a missing exit code means the probe failed, not "not contained"', () => {
  // runFile leaves `code` undefined for spawn failures, timeouts and kills: the
  // command never answered the question.
  assert.equal(classifyContainment({ ok: false }), 'probe-failed')
})

test('an unexpected exit code means the probe failed', () => {
  assert.equal(classifyContainment({ ok: false, code: 129 }), 'probe-failed')
})

test('releaseVersion strips only the official dsh-v prefix', () => {
  assert.equal(releaseVersion('dsh-v0.1.7-alpha.1'), '0.1.7-alpha.1')
  assert.equal(releaseVersion('dsh-v0.1.2-rc.1'), '0.1.2-rc.1')
  assert.equal(releaseVersion('other-tag'), 'other-tag')
})
