import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ACTIVITY_LINE_MAX_CHARS,
  ACTIVITY_LOG_KEEP_BYTES,
  ACTIVITY_LOG_MAX_BYTES,
  ACTIVITY_MAX_LINES,
  LOG_RELOAD_LINES,
} from './timing.ts'
import { readLogTailBytes } from './logs.ts'

export interface ActivityEntry {
  id: number
  text: string
  busy: boolean
}

const activity: ActivityEntry[] = []
let activitySeq = 0
const TRUNCATION_MARKER = '… [truncated]'
let consolePath = ''

function clampLine(line: string): string {
  if (line.length <= ACTIVITY_LINE_MAX_CHARS) return line
  return line.slice(0, ACTIVITY_LINE_MAX_CHARS) + TRUNCATION_MARKER
}

function readTailText(file: string, maxBytes: number): string | undefined {
  const size = fs.statSync(file).size
  const text = readLogTailBytes(file, maxBytes)
  if (text === undefined) return undefined
  if (size <= maxBytes) return text
  // A read that starts mid-file can begin mid-character; drop the partial first line.
  const newline = text.indexOf('\n')
  return newline === -1 ? '' : text.slice(newline + 1)
}

function trimLogFile(file: string): void {
  try {
    if (fs.statSync(file).size <= ACTIVITY_LOG_MAX_BYTES) return
    const text = readTailText(file, ACTIVITY_LOG_KEEP_BYTES)
    if (text !== undefined) fs.writeFileSync(file, text, 'utf8')
  } catch {
    // Best effort: the next load retries the trim.
  }
}

export function activityLogFile(): string {
  return consolePath
}

export function setLogPath(value: string): void {
  consolePath = value
  try {
    if (!fs.existsSync(consolePath)) return
    trimLogFile(consolePath)
    const text = readTailText(consolePath, ACTIVITY_LOG_KEEP_BYTES)
    if (text === undefined) return
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
    for (const line of lines.slice(-LOG_RELOAD_LINES)) {
      if (!line.includes('[dbg]')) pushActivity(line)
    }
  } catch {
    // Best effort: the feed is usable without a replay.
  }
}

function appendLog(entry: string): void {
  if (!consolePath) return
  try {
    fs.mkdirSync(path.dirname(consolePath), { recursive: true })
    fs.appendFileSync(consolePath, clampLine(entry) + '\n')
  } catch {
    // Best effort: a failed write must not disturb the panel.
  }
}

export function dbg(line: string): void {
  appendLog(`[${new Date().toLocaleTimeString()}] [dbg] ${line}`)
}

function pushActivity(entry: string, isBusy = false): number {
  const id = ++activitySeq
  activity.push({ id, text: clampLine(entry), busy: isBusy })
  if (activity.length > ACTIVITY_MAX_LINES) activity.splice(0, activity.length - ACTIVITY_MAX_LINES)
  return id
}

export function addActivity(line: string, isBusy = false): number {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`
  const id = pushActivity(entry, isBusy)
  appendLog(entry)
  return id
}

export function getActivity(): ReadonlyArray<ActivityEntry> {
  // Copies, not the live array: callers must not be able to mutate the feed.
  return activity.map((entry) => ({ ...entry }))
}

export function finishBusy(id: number): void {
  const entry = activity.find((e) => e.id === id)
  if (entry !== undefined) entry.busy = false
}

export async function withBusy<T>(label: string, task: () => Promise<T>): Promise<T> {
  // The feed has no reaper: a throw between add and finish would spin forever.
  const id = addActivity(label, true)
  try {
    return await task()
  } finally {
    finishBusy(id)
  }
}

export function clearConsole(): void {
  activity.length = 0
  if (!consolePath) return
  try {
    fs.mkdirSync(path.dirname(consolePath), { recursive: true })
    fs.writeFileSync(consolePath, '')
  } catch {
    // The feed is already cleared; a failed write only leaves the old log file.
  }
}

export function fileSizeSafe(p: string): number {
  if (!p) return 0
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}
