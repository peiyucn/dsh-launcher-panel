/**
 * Tests for `src/server/log-tail.ts`.
 *
 * The tailer became testable when it was split out of server.ts (no VS Code
 * dependency). It matters beyond convenience: `displayLine` is the only writer
 * of the per-run output count that the silent-exit diagnosis reads, so a tailer
 * that dies silently also blinds that diagnosis.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLogTail, stopLogTail, type LogTailHost } from '../src/server/log-tail.ts'
import { LOG_TAIL_POLL_MS } from '../src/timing.ts'

/** A host that records what the tailer emits, backed by a real file. */
function makeHost(logFile: string) {
  const lines: string[] = []
  const activities: string[] = []
  const host: LogTailHost = {
    serverLogFile: () => logFile,
    displayLine: (line) => { lines.push(line) },
    addActivity: (line) => { activities.push(line); return activities.length },
  }
  return { host, lines, activities }
}

/** Wait for the poll tick to pick up whatever was written last. */
const settle = () => new Promise((resolve) => setTimeout(resolve, LOG_TAIL_POLL_MS * 2 + 60))

test('the tailer streams appended lines and keeps a partial line buffered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tail-'))
  const logFile = join(dir, 'server.log')
  const { host, lines } = makeHost(logFile)
  try {
    startLogTail(host)
    // A whole line plus a fragment: only the whole line is emitted now.
    appendFileSync(logFile, 'first\nhalf')
    await settle()
    assert.deepEqual(lines, ['first'], 'the incomplete tail must not be emitted yet')

    // Completing it releases the buffered fragment as one line.
    appendFileSync(logFile, '-done\n')
    await settle()
    assert.deepEqual(lines, ['first', 'half-done'])
  } finally {
    stopLogTail(host)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tailer re-reads from the start when the log is truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tail-trunc-'))
  const logFile = join(dir, 'server.log')
  const { host, lines } = makeHost(logFile)
  try {
    startLogTail(host)
    appendFileSync(logFile, 'before\n')
    await settle()
    // A fresh start truncates the log (dsh.clearServerLogOnStart); the offset
    // must reset rather than staying past the new, shorter content.
    writeFileSync(logFile, 'after\n')
    await settle()
    assert.deepEqual(lines, ['before', 'after'])
  } finally {
    stopLogTail(host)
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Regression: `fs.watch` throws ENOENT when the path is gone, and it sat
 * outside the try/catch. The dangerous window is *between* the `openSync` that
 * ensures the file exists and the `fs.watch` that binds to it — a delete there
 * (the panel's Clear button) used to unwind the caller's spawn, leaving no
 * process and a `waitForPort` with nothing to wait for.
 *
 * Reaching that window from a test needs the delete to happen inside it, so the
 * file is removed by a host whose `serverLogFile()` reports the path once and
 * then deletes it — i.e. the second call (the watch) sees it gone, which is
 * precisely the race.
 */
test('startLogTail never throws when the log vanishes between open and watch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tail-race-'))
  const logFile = join(dir, 'server.log')
  try {
    writeFileSync(logFile, 'x')
    let calls = 0
    const host: LogTailHost = {
      serverLogFile: () => {
        calls++
        // First call is the existence check; delete just before the watch.
        if (calls === 2) unlinkSync(logFile)
        return logFile
      },
      displayLine: () => {},
      addActivity: () => 1,
    }
    assert.doesNotThrow(() => startLogTail(host), 'a vanished log must not abort a start')
    stopLogTail(host)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stopLogTail is safe to call when no tail is running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tail-none-'))
  const { host } = makeHost(join(dir, 'server.log'))
  try {
    assert.doesNotThrow(() => stopLogTail(host))
    assert.doesNotThrow(() => stopLogTail(host))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starting a tail twice replaces the first one instead of leaking it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tail-restart-'))
  const logFile = join(dir, 'server.log')
  const { host, lines } = makeHost(logFile)
  try {
    startLogTail(host)
    startLogTail(host)
    appendFileSync(logFile, 'once\n')
    await settle()
    // Two live tails would each emit the line; one tail emits it once.
    assert.deepEqual(lines.filter((l) => l === 'once'), ['once'])
  } finally {
    stopLogTail(host)
    rmSync(dir, { recursive: true, force: true })
  }
})
