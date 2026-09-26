/**
 * Tests for `src/server/activity.ts`: the bounded activity feed and the
 * server-output counting.
 *
 * These became testable when the module was split out of server.ts — it has no
 * VS Code dependency, so the feed's bounds and the NODE_DEBUG throttling can be
 * exercised directly instead of inferred.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addActivity,
  clearConsole,
  displayLine,
  finishBusy,
  getActivity,
  outputLineCount,
  resetRunCounters,
  scanLogForToken,
  setLogPath,
} from '../src/server/activity.ts'
import { ACTIVITY_MAX_LINES, MODULE_PROGRESS_EVERY } from '../src/timing.ts'
import { silentExitHint } from '../src/env.ts'

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

test('displayLine counts every line but throttles NODE_DEBUG=module output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-display-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()
    resetRunCounters()
    assert.equal(outputLineCount(), 0)

    // Blank lines do not count; real ones do.
    displayLine('   ')
    assert.equal(outputLineCount(), 0)
    displayLine('hello')
    displayLine('world')
    assert.equal(outputLineCount(), 2)

    // MODULE lines are counted and stay out of the feed until the throttle
    // fires, which is what keeps a slow source start from flooding the console.
    clearConsole()
    resetRunCounters()
    for (let i = 0; i < MODULE_PROGRESS_EVERY - 1; i++) displayLine('MODULE something')
    assert.equal(getActivity().length, 0, 'below the threshold nothing is shown')
    displayLine('MODULE something')
    const feed = getActivity()
    assert.equal(feed.length, 1)
    assert.ok(feed[0].text.includes(`Loading modules… (${MODULE_PROGRESS_EVERY})`))
    assert.equal(outputLineCount(), MODULE_PROGRESS_EVERY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanLogForToken reads the newest matching line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-token-'))
  try {
    setLogPath(join(dir, 'client.log'))
    // setLogPath derives the server log beside the client log; write two runs'
    // worth of output so "newest wins" is actually exercised.
    const serverLog = join(dir, 'server.log')
    clearConsole()
    const old = 'dsh web: http://127.0.0.1:3080/?token=OLDOLDOLDOLDOLDOLD'
    const fresh = 'dsh web: http://127.0.0.1:3080/?token=NEWNEWNEWNEWNEWNEW'
    writeFileSync(serverLog, `${old}\n${fresh}\n`)
    const token = scanLogForToken((line) => /token=([A-Za-z0-9_-]{8,})/.exec(line)?.[1])
    assert.equal(token, 'NEWNEWNEWNEWNEWNEW')
    // A log without a token yields undefined rather than throwing.
    writeFileSync(serverLog, 'nothing here\n')
    assert.equal(scanLogForToken((line) => /token=([A-Za-z0-9_-]{8,})/.exec(line)?.[1]), undefined)
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

test('the silent-exit diagnosis depends on a per-run line count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-silent-'))
  try {
    setLogPath(join(dir, 'client.log'))
    clearConsole()
    resetRunCounters()

    // A run that printed nothing is exactly the case the hint exists for.
    assert.equal(outputLineCount(), 0)
    const hint = silentExitHint({
      dshVersion: '0.1.7',
      nodeVersion: '24.0.0',
      supportsImportMetaMain: false,
      outputLines: outputLineCount(),
    })
    assert.ok(hint !== undefined, 'a silent exit must be explained')
    assert.match(hint, /import\.meta\.main/)

    // Any output from the run suppresses it — the guard is not always-on.
    displayLine('the server printed something')
    assert.equal(silentExitHint({
      dshVersion: '0.1.7',
      nodeVersion: '24.0.0',
      supportsImportMetaMain: false,
      outputLines: outputLineCount(),
    }), undefined)

    // The consequence of NOT resetting between runs: the count stays non-zero,
    // so every later silent exit is misread as "it printed something" and goes
    // unexplained. This is the state the missing spawnServer call produced.
    resetRunCounters()
    displayLine('run 1 output')
    const leaked = outputLineCount()
    assert.equal(leaked, 1)
    assert.equal(silentExitHint({
      dshVersion: '0.1.7',
      nodeVersion: '24.0.0',
      supportsImportMetaMain: false,
      outputLines: leaked, // what run 2 would see if the counter survived
    }), undefined, 'a leaked counter silences the diagnosis — hence the reset')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The reset above is a side effect that must happen when a server is spawned,
 * and `spawnServer` imports `vscode`, so it cannot be executed from a test.
 *
 * That gap is how the regression got in: extraction moved `spawnServer` into
 * `server/process.ts` and dropped the counters reset it used to do inline. A
 * behavioural test cannot observe it, so this asserts the call site itself —
 * scoped to the function body, not the file, so a call moved elsewhere fails.
 */
test('spawnServer resets the per-run counters before every spawn', () => {
  const source = readFileSync(new URL('../src/server/process.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function spawnServer(')
  assert.notEqual(start, -1, 'spawnServer must exist in server/process.ts')

  // Walk braces to isolate the body, so a call from a neighbouring function
  // cannot satisfy this assertion.
  let depth = 0
  let end = start
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const body = source.slice(start, end)
  assert.match(body, /host\.resetRunCounters\(\)/,
    'spawnServer must zero the per-run counters (server/process.ts)')
  // The companion bookkeeping must stay with it.
  assert.match(body, /host\.clearWebToken\(\)/)
})
