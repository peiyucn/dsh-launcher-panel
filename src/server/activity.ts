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
 *
 * @module server/activity
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ACTIVITY_MAX_LINES, LOG_RELOAD_LINES } from '../timing.ts'

/** One line in the panel activity feed; `busy` marks an in-progress operation. */
export interface ActivityEntry {
  id: number
  text: string
  busy: boolean
}

const activity: ActivityEntry[] = []
let activitySeq = 0

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
    if (fs.existsSync(consolePath)) {
      const lines = fs.readFileSync(consolePath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
      for (const line of lines.slice(-LOG_RELOAD_LINES)) {
        if (line.includes('[dbg]')) continue
        pushActivity(line)
      }
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
    fs.appendFileSync(consolePath, entry + '\n')
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
  activity.push({ id, text: entry, busy: isBusy })
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

/** The panel activity feed (Start/Stop command dynamics), newest last. */
export function getActivity(): ActivityEntry[] {
  return activity
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
