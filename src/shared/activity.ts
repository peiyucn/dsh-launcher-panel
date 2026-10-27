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
  /** Set for instance-scoped entries; global launcher entries leave it undefined. */
  instanceId?: string
}

const activity: ActivityEntry[] = []
let activitySeq = 0
const TRUNCATION_MARKER = '… [truncated]'
const trimmedInstanceLogs = new Set<string>()
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

export function instanceActivityLogFile(instanceId: string): string {
  if (!consolePath) return ''
  return path.join(path.dirname(consolePath), 'instances', instanceId, 'client.log')
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

function appendLog(entry: string, instanceId?: string): void {
  if (!consolePath) return
  const file = instanceId === undefined ? consolePath : instanceActivityLogFile(instanceId)
  if (file === '') return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (instanceId !== undefined && !trimmedInstanceLogs.has(instanceId)) {
      trimmedInstanceLogs.add(instanceId)
      trimLogFile(file)
    }
    fs.appendFileSync(file, clampLine(entry) + '\n')
  } catch {
    // Best effort: a failed write must not disturb the panel.
  }
}

export function dbg(line: string): void {
  appendLog(`[${new Date().toLocaleTimeString()}] [dbg] ${line}`)
}

function pushActivity(entry: string, isBusy = false, instanceId?: string): number {
  const id = ++activitySeq
  activity.push({ id, text: clampLine(entry), busy: isBusy, ...instanceId === undefined ? {} : { instanceId } })
  if (activity.length > ACTIVITY_MAX_LINES) activity.splice(0, activity.length - ACTIVITY_MAX_LINES)
  return id
}

export function addActivity(line: string, isBusy = false, instanceId?: string): number {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`
  const id = pushActivity(entry, isBusy, instanceId)
  appendLog(entry, instanceId)
  return id
}

/**
 * Feed slice for one tab: launcher-wide entries (no instance) plus the given
 * instance's own entries. Without an id every entry is returned.
 */
export function getActivity(instanceId?: string): ReadonlyArray<ActivityEntry> {
  const source = instanceId === undefined
    ? activity
    : activity.filter((entry) => entry.instanceId === undefined || entry.instanceId === instanceId)
  return source.map((entry) => ({ ...entry }))
}

/** Push the tail of one instance's launcher log back into the feed (window reload). */
export function replayInstanceActivity(instanceId: string): void {
  const file = instanceActivityLogFile(instanceId)
  if (file === '' || !fs.existsSync(file)) return
  try {
    trimLogFile(file)
    const text = readTailText(file, ACTIVITY_LOG_KEEP_BYTES)
    if (text === undefined) return
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
    for (const line of lines.slice(-LOG_RELOAD_LINES)) pushActivity(line, false, instanceId)
  } catch {
    // Best effort: a broken file must not break activation.
  }
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

/** Clear one tab's console: its scoped feed entries and its launcher log file. */
export function clearInstanceConsole(instanceId: string): void {
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].instanceId === instanceId) activity.splice(i, 1)
  }
  const file = instanceActivityLogFile(instanceId)
  if (file === '') return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
  } catch {
    // Best effort: the feed is already cleared.
  }
}

/** Clear every feed entry and the global launcher log. */
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
