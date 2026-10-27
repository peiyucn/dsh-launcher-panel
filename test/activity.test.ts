import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import {
  ACTIVITY_LINE_MAX_CHARS,
  ACTIVITY_LOG_KEEP_BYTES,
  ACTIVITY_LOG_MAX_BYTES,
  ACTIVITY_MAX_LINES,
} from '../src/timing.ts'

test('the activity feed is bounded and keeps the newest entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-activity-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()

    const total = ACTIVITY_MAX_LINES + 25
    for (let i = 0; i < total; i++) addActivity(`line ${i}`)

    const feed = getActivity()
    assert.equal(feed.length, ACTIVITY_MAX_LINES, 'feed must stay at its cap')
    assert.ok(feed[feed.length - 1].text.endsWith(`line ${total - 1}`))
    assert.ok(!feed.some((e) => e.text.endsWith('line 0')))
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
    assert.equal(getActivity().filter((e) => e.busy).length, 0,
      'a failing task must not leave a spinner running')

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

test('one oversized line is truncated in the feed and in the log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-linecap-'))
  try {
    const file = join(dir, 'client.log')
    setLogPath(file)
    clearConsole()
    addActivity('x'.repeat(ACTIVITY_LINE_MAX_CHARS * 2))
    const entry = getActivity()[0].text
    assert.ok(entry.length <= ACTIVITY_LINE_MAX_CHARS + 32, `feed line kept at the cap (${entry.length})`)
    assert.ok(entry.includes('[truncated]'), 'the truncation marker is visible')
    const written = readFileSync(file, 'utf8').trimEnd()
    assert.ok(written.length <= ACTIVITY_LINE_MAX_CHARS + 32, `log line kept at the cap (${written.length})`)
    assert.ok(written.includes('[truncated]'), 'the log line carries the same marker')
    addActivity('short line')
    assert.ok(getActivity()[1].text.endsWith('short line'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getActivity returns a snapshot that cannot mutate the feed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snapshot-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()
    addActivity('kept line')
    const snapshot = getActivity()
    const again = getActivity()
    assert.notEqual(snapshot, again, 'each call returns a fresh array')
    assert.notEqual(snapshot[0], again[0], 'entries are copies too')
    ;(snapshot as unknown as Array<{ id: number; text: string; busy: boolean }>).push({ id: -1, text: 'injected', busy: false })
    snapshot[0].text = 'polluted'
    const live = getActivity()
    assert.equal(live.length, 1)
    assert.ok(live[0].text.endsWith('kept line'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setLogPath trims an oversized client log to its tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-logtrim-'))
  try {
    const file = join(dir, 'client.log')
    const line = 'y'.repeat(1024)
    const count = Math.ceil((ACTIVITY_LOG_MAX_BYTES + 1024 * 1024) / (line.length + 1)) + 10
    writeFileSync(file, `HEAD-MARKER\n${(line + '\n').repeat(count)}TAIL-MARKER\n`)
    assert.ok(statSync(file).size > ACTIVITY_LOG_MAX_BYTES, 'fixture must exceed the trim threshold')

    setLogPath(file)

    const size = statSync(file).size
    assert.ok(size <= ACTIVITY_LOG_KEEP_BYTES, `trimmed log size ${size} must be within the keep bound`)
    const content = readFileSync(file, 'utf8')
    assert.ok(content.includes('TAIL-MARKER'), 'the newest line survives the trim')
    assert.ok(!content.includes('HEAD-MARKER'), 'the oldest lines are dropped')
    const feed = getActivity()
    assert.ok(feed.length > 0)
    assert.ok(feed[feed.length - 1].text.includes('TAIL-MARKER'), 'the trim happens before the tail replay')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
