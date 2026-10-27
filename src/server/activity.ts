/**
 * The launcher's activity feed and its console log file.
 *
 * `client.log` records launcher activity (start/stop, installs, diagnostics).
 * Server output is a per-instance concern — each `InstanceRuntime` keeps its own
 * `server.log` and mirrors only the startup output into the panel, so this
 * module never touches a server log.
 *
 * The activity feed is bounded ({@link ACTIVITY_MAX_LINES}) because it lives for
 * the whole extension session while a busy launcher can emit lines continuously.
 * Individual lines are bounded too ({@link ACTIVITY_LINE_MAX_CHARS}): one tool
 * output or error message can be megabytes, and the line-count cap alone would
 * let it through. The persisted log is trimmed on load
 * ({@link ACTIVITY_LOG_MAX_BYTES} → {@link ACTIVITY_LOG_KEEP_BYTES}) so an
 * always-running launcher cannot grow `client.log` without bound.
 *
 * @module server/activity
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ACTIVITY_LINE_MAX_CHARS,
  ACTIVITY_LOG_KEEP_BYTES,
  ACTIVITY_LOG_MAX_BYTES,
  ACTIVITY_MAX_LINES,
  LOG_RELOAD_LINES,
} from '../timing.ts'

/** One line in the panel activity feed; `busy` marks an in-progress operation. */
export interface ActivityEntry {
  id: number
  text: string
  busy: boolean
}

const activity: ActivityEntry[] = []
let activitySeq = 0

/** Appended to a line that had to be shortened. */
const TRUNCATION_MARKER = '… [truncated]'

/** Shorten one line to the feed/log bound, keeping the end marker visible. */
function clampLine(line: string): string {
  if (line.length <= ACTIVITY_LINE_MAX_CHARS) return line
  return line.slice(0, ACTIVITY_LINE_MAX_CHARS) + TRUNCATION_MARKER
}

/**
 * Read the last `maxBytes` bytes of a file as UTF-8 text.
 *
 * When the read does not start at byte 0 the first (partial) line is dropped:
 * decoding may begin in the middle of a multi-byte character, and a half line
 * is noise in the feed.
 */
function readTailText(file: string, maxBytes: number): string {
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(stat.size - start)
    const read = fs.readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, read).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline === -1 ? '' : text.slice(newline + 1)
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Keep `client.log` bounded: once it exceeds {@link ACTIVITY_LOG_MAX_BYTES},
 * rewrite it as the newest {@link ACTIVITY_LOG_KEEP_BYTES} bytes. Best effort —
 * a failed trim only means the next load retries it.
 */
function trimLogFile(file: string): void {
  try {
    if (fs.statSync(file).size <= ACTIVITY_LOG_MAX_BYTES) return
    fs.writeFileSync(file, readTailText(file, ACTIVITY_LOG_KEEP_BYTES), 'utf8')
  } catch {
    // best effort
  }
}

/** The launcher activity log (`client.log`). */
let consolePath = ''

/** The launcher activity log path (empty before the first start). */
export function activityLogFile(): string {
  return consolePath
}

/** Point the log sink at the log folder and replay the tail into the feed. */
export function setLogPath(value: string): void {
  consolePath = value
  try {
    if (!fs.existsSync(consolePath)) return
    trimLogFile(consolePath)
    // Only the tail is replayed (and read): the log may legitimately be a few
    // megabytes, and activation should not parse all of it.
    const lines = readTailText(consolePath, ACTIVITY_LOG_KEEP_BYTES).split(/\r?\n/).filter((l) => l.length > 0)
    for (const line of lines.slice(-LOG_RELOAD_LINES)) {
      if (line.includes('[dbg]')) continue
      pushActivity(line)
    }
  } catch {
    // best effort
  }
}

/** Append one entry to the console log file (best effort). */
function appendLog(entry: string): void {
  if (!consolePath) return
  try {
    fs.mkdirSync(path.dirname(consolePath), { recursive: true })
    fs.appendFileSync(consolePath, clampLine(entry) + '\n')
  } catch {
    // best effort
  }
}

/** Append a diagnostic line to the log file only (kept out of the console feed). */
export function dbg(line: string): void {
  appendLog(`[${new Date().toLocaleTimeString()}] [dbg] ${line}`)
}

/** Append one entry to the feed without touching the log file. */
function pushActivity(entry: string, isBusy = false): number {
  const id = ++activitySeq
  activity.push({ id, text: clampLine(entry), busy: isBusy })
  if (activity.length > ACTIVITY_MAX_LINES) activity.splice(0, activity.length - ACTIVITY_MAX_LINES)
  return id
}

/** Append one line to the panel activity feed + the log file. */
export function addActivity(line: string, isBusy = false): number {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`
  const id = pushActivity(entry, isBusy)
  appendLog(entry)
  return id
}

/**
 * The panel activity feed (Start/Stop command dynamics), newest last.
 *
 * A snapshot: callers get copies of both the array and the entries, so they
 * cannot mutate the feed (panel payload builders used to share the live array).
 */
export function getActivity(): ReadonlyArray<ActivityEntry> {
  return activity.map((entry) => ({ ...entry }))
}

/** Finish one busy entry by its addActivity id (concurrent busy operations each
 * clear only their own spinner). */
export function finishBusy(id: number): void {
  const entry = activity.find((e) => e.id === id)
  if (entry !== undefined) entry.busy = false
}

/**
 * Run `task` with a spinner in the feed, clearing it whether the task succeeds
 * or throws.
 *
 * Every caller of addActivity(…, true) has to pair it with finishBusy, and a
 * throw between the two leaves the spinner turning for the rest of the session
 * (the feed has no reaper). Wrapping the pair means the release cannot be
 * forgotten on a failure path.
 */
export async function withBusy<T>(label: string, task: () => Promise<T>): Promise<T> {
  const id = addActivity(label, true)
  try {
    return await task()
  } finally {
    finishBusy(id)
  }
}

/** Clear the in-memory feed and the persisted console log (best effort). */
export function clearConsole(): void {
  activity.length = 0
  if (!consolePath) return
  try {
    fs.mkdirSync(path.dirname(consolePath), { recursive: true })
    fs.writeFileSync(consolePath, '')
  } catch {
    // A failure here only means the log file keeps the old lines; the feed is
    // already cleared and the next append recreates the file.
  }
}

/** Size of a file in bytes, 0 when absent or unreadable. */
export function fileSizeSafe(p: string): number {
  if (!p) return 0
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}
