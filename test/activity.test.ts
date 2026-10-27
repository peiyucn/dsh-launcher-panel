/**
 * Tests for `src/server/activity.ts`: the bounded activity feed and the spinner
 * bookkeeping.
 *
 * These became testable when the module was split out of the old server
 * lifecycle — it has no VS Code dependency, so the feed's bounds and the busy
 * pairing can be exercised directly instead of inferred.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addActivity,
  clearConsole,
  finishBusy,
  getActivity,
  setLogPath,
  withBusy,
} from '../src/server/activity.ts'
import { ACTIVITY_MAX_LINES } from '../src/timing.ts'

test('the activity feed is bounded and keeps the newest entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-activity-'))
  try {
    // Point the log sink at a temp file so nothing touches the real home dir.
    setLogPath(join(dir, 'client.log'))
    clearConsole()

    const total = ACTIVITY_MAX_LINES + 25
    for (let i = 0; i < total; i++) addActivity(`line ${i}`)

    const feed = getActivity()
    assert.equal(feed.length, ACTIVITY_MAX_LINES, 'feed must stay at its cap')
    // The newest line survives; the oldest were dropped.
    assert.ok(feed[feed.length - 1].text.endsWith(`line ${total - 1}`))
    assert.ok(!feed.some((e) => e.text.endsWith('line 0')))
    // Ids keep increasing even after entries are dropped, so finishBusy can
    // never address a recycled entry.
    assert.ok(feed[feed.length - 1].id > ACTIVITY_MAX_LINES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finishBusy clears only the entry it was given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-busy-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()
    const first = addActivity('first', true)
    const second = addActivity('second', true)
    finishBusy(first)
    const feed = getActivity()
    assert.equal(feed.find((e) => e.id === first)?.busy, false)
    assert.equal(feed.find((e) => e.id === second)?.busy, true)
    // An unknown id is a no-op, not a throw.
    finishBusy(999999)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('addActivity writes to the client log file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-logwrite-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()
    addActivity('a marker line')
    const written = readFileSync(join(dir, 'client.log'), 'utf8')
    assert.ok(written.includes('a marker line'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * `withBusy` exists because every `addActivity(…, true)` must be paired with
 * `finishBusy`, and a throw in between used to leave the spinner turning for
 * the rest of the session (the feed has no reaper).
 */
test('withBusy clears its spinner when the task throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-withbusy-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()

    const value = await withBusy('↻ doing a thing…', async () => 42)
    assert.equal(value, 42, 'the task result is passed through')
    assert.equal(getActivity().filter((e) => e.busy).length, 0)

    await assert.rejects(
      withBusy('↻ failing thing…', async () => { throw new Error('boom') }),
      /boom/,
    )
    // The point of the helper: the spinner is gone even on the throw path.
    assert.equal(getActivity().filter((e) => e.busy).length, 0,
      'a failing task must not leave a spinner running')

    // Two concurrent busy operations each clear only their own entry.
    const slow = withBusy('↻ one…', () => new Promise((resolve) => setTimeout(() => resolve('a'), 20)))
    const fast = withBusy('↻ two…', async () => 'b')
    assert.equal(await fast, 'b')
    assert.equal(getActivity().filter((e) => e.busy).length, 1, 'the other spinner is untouched')
    assert.equal(await slow, 'a')
    assert.equal(getActivity().filter((e) => e.busy).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
