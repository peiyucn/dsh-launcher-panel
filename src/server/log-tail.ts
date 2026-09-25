/**
 * Streaming the server log file into the dashboard activity feed.
 *
 * On Windows the server runs under a hidden console and writes its output by
 * cmd redirection into a log file; the launcher cannot read the child's pipes
 * in that mode, so it follows the file instead. The same tailer serves POSIX,
 * where the output is piped — both paths funnel through `displayLine`, which is
 * what makes the per-run output count meaningful.
 *
 * Two watches are deliberately active at once: `fs.watch` is the fast path, and
 * a poll covers the appends it misses on Windows.
 *
 * @module server/log-tail
 */

import * as fs from 'node:fs'
import { LOG_TAIL_POLL_MS } from '../timing.ts'

/** What the tailer needs from the sink it feeds. */
export interface LogTailHost {
  /** The server log path (empty before the first start). */
  serverLogFile: () => string
  /** Append one server-output line to the activity feed. */
  displayLine: (line: string) => void
  /** Append one launcher-activity line (used for a trailing partial line). */
  addActivity: (line: string, isBusy?: boolean) => number
}

let watcher: fs.FSWatcher | undefined
let timer: ReturnType<typeof setInterval> | undefined
let offset = 0
let buffer = ''

/** Whether a tail is currently running. */
export function isTailing(): boolean {
  return timer !== undefined || watcher !== undefined
}

/** The log file's size in bytes, 0 when it is absent or unreadable. */
function logSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Stream the server log file into the dashboard activity feed as it grows.
 * Calling this while a tail is running restarts it.
 */
export function startLogTail(host: LogTailHost): void {
  stopLogTail(host)
  buffer = ''
  try {
    // Ensure the log file exists before watching it, otherwise fs.watch dies
    // on ENOENT and never recovers when cmd later creates the file.
    fs.closeSync(fs.openSync(host.serverLogFile(), 'a'))
    // Stream only output written after this point (the file is appended to).
    offset = logSize(host.serverLogFile())
  } catch {
    offset = 0
    return
  }
  const pump = (): void => {
    const size = logSize(host.serverLogFile())
    if (size < offset) offset = 0 // file truncated by a fresh start
    if (size <= offset) return
    let fd: number | undefined
    try {
      fd = fs.openSync(host.serverLogFile(), 'r')
      const buf = Buffer.alloc(size - offset)
      const read = fs.readSync(fd, buf, 0, buf.length, offset)
      offset += read
      buffer += buf.subarray(0, read).toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) host.displayLine(line)
    } catch {
      // File may be locked mid-write; retry on the next change event.
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  pump()
  watcher = fs.watch(host.serverLogFile(), () => pump())
  watcher.on('error', () => {})
  // fs.watch can miss appends on Windows; poll as a reliable fallback.
  timer = setInterval(() => pump(), LOG_TAIL_POLL_MS)
}

/** Stop streaming the server log into the dashboard (safe to call on deactivate). */
export function stopLogTail(host: LogTailHost): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  watcher?.close()
  watcher = undefined
  if (buffer) {
    const trimmed = buffer.trimEnd()
    if (trimmed) host.addActivity(trimmed)
    buffer = ''
  }
}
