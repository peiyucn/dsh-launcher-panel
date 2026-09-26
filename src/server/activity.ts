/**
 * The launcher's two output sinks: the panel activity feed and the log files.
 *
 * There are two files and they are deliberately distinct. `client.log` records
 * launcher activity; `server.log` holds dsh's own stdout/stderr — the server
 * redirects its output into that file and holds it open, so keeping them
 * separate is what stops the launcher's writes from being lost to a lock.
 *
 * The activity feed is bounded ({@link ACTIVITY_MAX_LINES}) because it lives for
 * the whole extension session while a busy server can emit lines continuously.
 *
 * @module server/activity
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ACTIVITY_MAX_LINES, LOG_RELOAD_LINES, MODULE_PROGRESS_EVERY } from '../timing.ts'

/** One line in the panel activity feed; `busy` marks an in-progress operation. */
export interface ActivityEntry {
  id: number
  text: string
  busy: boolean
}

const activity: ActivityEntry[] = []
let activitySeq = 0

/** The launcher activity log (`client.log`) and the server output log. */
let consolePath = ''
let logPath = ''

/** Server output lines captured for the current run (0 = the child died silently). */
let serverOutputLines = 0
/** Module-load lines seen so far, for the periodic progress note. */
let moduleLoadCount = 0

/** Reset the per-run output counters. Called when a server is spawned. */
export function resetRunCounters(): void {
  moduleLoadCount = 0
  serverOutputLines = 0
}

/** Server output lines captured for the current run. */
export function outputLineCount(): number {
  return serverOutputLines
}

/** The launcher activity log path (empty before the first start). */
export function activityLogFile(): string {
  return consolePath
}

/** The server output log path (empty before the first start). */
export function serverLogFile(): string {
  return logPath
}

/** Point both sinks at the log folder and replay the tail into the feed. */
export function setLogPath(value: string): void {
  // Both logs live in one folder (client.log = launcher activity, server.log
  // = server output). The server redirects to the latter (holding it open),
  // so keeping them distinct avoids the launcher's writes being lost to locks.
  consolePath = value
  logPath = path.join(path.dirname(value), 'server.log')
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
export function pushActivity(entry: string, isBusy = false): number {
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

/** Append one server-output line to the activity feed only (already in the log file). */
export function displayLine(line: string): void {
  const trimmed = line.trimEnd()
  if (!trimmed) return
  // Both output paths funnel through here — the piped spawn and the
  // hidden-console tail that reads the server log — so this counts every line
  // the run produced (0 = the child died without printing anything).
  serverOutputLines++
  // NODE_DEBUG=module is extremely verbose; keep individual lines out of the
  // console feed (they stay in the server log file), but surface a periodic
  // count so a slow source startup still shows progress.
  if (/^MODULE\s/.test(trimmed)) {
    moduleLoadCount++
    if (moduleLoadCount % MODULE_PROGRESS_EVERY === 0) {
      pushActivity(`[${new Date().toLocaleTimeString()}] ℹ Loading modules… (${moduleLoadCount})`)
    }
    return
  }
  pushActivity(`[${new Date().toLocaleTimeString()}] ${trimmed}`)
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

/**
 * Clear the console log: the in-memory feed and the persisted files.
 *
 * A locked server log is reported into the feed rather than thrown: the running
 * server holds that file open, so a Clear during a run cannot succeed and the
 * user needs to know why.
 */
export function clearConsole(): void {
  activity.length = 0
  for (const file of [consolePath, logPath]) {
    if (!file) continue
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '')
    } catch {
      // Only a real lock (EBUSY/EPERM from the running server) is worth
      // telling the user about; a missing folder is handled by the mkdir above.
      if (file === logPath) {
        pushActivity('⚠ Server log is locked by the running server — Stop first, then Clear')
      }
    }
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

/** Truncate the server log so each run starts clean (best effort). */
export function truncateServerLog(): void {
  if (!logPath) return
  try {
    fs.writeFileSync(logPath, '')
  } catch {
    // Best effort: a just-stopped server may still hold the file open.
  }
}

/**
 * Read the newest web access token out of the server log.
 *
 * The log is the single output sink on every platform, so it is also where dsh
 * ≥ 0.1.2-alpha.1's startup URL lands.
 *
 * @param extract - pulls a token out of one log line (kept as a parameter so
 *   this module does not own the token's shape).
 * @returns the token, or undefined when the log does not carry one yet.
 */
export function scanLogForToken(extract: (line: string) => string | undefined): string | undefined {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/)
    // Newest line first: with dsh.clearServerLogOnStart off, the log may hold
    // several runs, and the current run's token is the most recent one.
    for (let i = lines.length - 1; i >= 0; i--) {
      const token = extract(lines[i])
      if (token) return token
    }
  } catch {
    // log not written yet
  }
  return undefined
}

/** Ensure the log folder exists, reporting failure through the caller's message. */
export function ensureLogDir(): { ok: true } | { ok: false; dir: string } {
  const dir = path.dirname(logPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
    return { ok: true }
  } catch {
    return { ok: false, dir }
  }
}
