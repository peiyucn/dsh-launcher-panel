import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { decodeChildOutput } from '../shared/proc.ts'
import { NODE_PROBE_TIMEOUT_MS } from '../shared/timing.ts'
import { isPortOpen } from '../dsh/probes.ts'

/** The dsh CLI entry token (a path) from a command line. */
export function dshEntryToken(command: string): string | undefined {
  const tokens = command.replace(/["']/g, '').split(/\s+/).filter((token) => token !== '')
  return tokens.find(isDshEntryToken)
}

/** One process as reported by the platform's process list. */
export interface ProcessEntry {
  pid: number
  command: string
}

/** A dsh web server the explicit "detect running dsh" action found. */
export interface DetectedDsh {
  pid: number
  port: number
  /** Profile argument; empty when the command does not carry one. */
  profile: string
  /** DSH_HOME from the process environment; empty when it could not be read. */
  home: string
  command: string
}

const WINDOWS_PROCESS_SCRIPT = 'Get-CimInstance Win32_Process '
  + '| ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }'

// Command lines can be long (source mode debug flags, deep checkout paths); keep headroom.
const PROCESS_LIST_MAX_BUFFER = 16 * 1024 * 1024

/** True when the argv token is a dsh CLI entry (global shim, installed bin.js or source entry). */
export function isDshEntryToken(token: string): boolean {
  const trimmed = token.replace(/^["']|["']$/g, '')
  if (/(?:^|[\\/])dsh$/i.test(trimmed) || /(?:^|[\\/])dsh\.(?:js|cjs|mjs|cmd)$/i.test(trimmed)) return true
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin(?:\.js)?$/i.test(trimmed)) return true
  return /apps[\\/]cli[\\/](?:src|dist)[\\/]bin\.(?:ts|js)$/i.test(trimmed)
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

/**
 * Parse a dsh web-server command line into its profile and port.
 * Supports `node /usr/local/bin/dsh <profile> --port N`, the installed
 * `@deepseek-ai/dsh/lib/bin.js` entry and the source `apps/cli/src/bin.ts` entry.
 */
export function parseDshServerCommand(command: string): { port: number; profile: string } | undefined {
  const tokens = command.replace(/["']/g, '').split(/\s+/).filter((token) => token !== '')
  const entryIndex = tokens.findIndex(isDshEntryToken)
  if (entryIndex === -1) return undefined
  let port: number | undefined
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--port') port = parsePort(tokens[i + 1])
    else if (tokens[i].startsWith('--port=')) port = parsePort(tokens[i].slice('--port='.length))
    if (port !== undefined) break
  }
  if (port === undefined) return undefined
  const profile = tokens[entryIndex + 1] !== undefined && !tokens[entryIndex + 1].startsWith('-')
    ? tokens[entryIndex + 1]
    : ''
  return { port, profile }
}

function parsePid(text: string): number | undefined {
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** Windows CIM probe output: one `<pid>\t<command line>` row per process. */
export function parseWindowsProcessList(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const tab = line.indexOf('\t')
    const pid = parsePid((tab === -1 ? line : line.slice(0, tab)).trim())
    if (pid === undefined) continue
    entries.push({ pid, command: tab === -1 ? '' : line.slice(tab + 1).trim() })
  }
  return entries
}

/** `ps -eo pid=,args=` output: leading padding, the pid, then the command line. */
export function parsePosixProcessList(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const pid = match === null ? undefined : parsePid(match[1])
    if (match === null || pid === undefined) continue
    entries.push({ pid, command: match[2].trim() })
  }
  return entries
}

function execText(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true, timeout: timeoutMs, encoding: 'buffer', maxBuffer: PROCESS_LIST_MAX_BUFFER,
    }, (error, stdout) => {
      resolve(error ? undefined : decodeChildOutput(stdout ?? Buffer.alloc(0)))
    })
  })
}

export type ProcessLister = () => Promise<ProcessEntry[] | undefined>

/** Platform process list; undefined when the platform cannot provide one. */
export const listProcessEntries: ProcessLister = async () => {
  if (process.platform === 'win32') {
    const output = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT], NODE_PROBE_TIMEOUT_MS)
    return output === undefined ? undefined : parseWindowsProcessList(output)
  }
  if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'freebsd') {
    const output = await execText('ps', ['-eo', 'pid=,args='], NODE_PROBE_TIMEOUT_MS)
    return output === undefined ? undefined : parsePosixProcessList(output)
  }
  return undefined
}

/** DSH_HOME from a Linux process environment; empty when unreadable. */
export function readProcessHome(pid: number): string {
  if (process.platform !== 'linux') return ''
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
    for (const pair of env.split('\0')) {
      if (pair.startsWith('DSH_HOME=')) return pair.slice('DSH_HOME='.length)
    }
  } catch {
    // Process exited or belongs to another user.
  }
  return ''
}

/** Name shown for a detected server before the user renames it. */
export function detectedName(profile: string, port: number): string {
  const trimmed = profile.trim()
  if (trimmed !== '' && trimmed !== 'web') return trimmed
  return `dsh :${port}`
}

export interface DetectDeps {
  list?: ProcessLister
  portOpen?: (port: number) => Promise<boolean>
  homeOf?: (pid: number) => string
}

/**
 * One-shot scan for dsh web servers this launcher did not start.
 * Ports owned by configured instances are excluded, so launcher-managed instances
 * never show up as detected duplicates.
 */
export async function detectDshServers(
  configuredPorts: ReadonlySet<number>,
  excludePids: ReadonlySet<number> = new Set(),
  deps: DetectDeps = {},
): Promise<DetectedDsh[]> {
  const entries = await (deps.list ?? listProcessEntries)()
  if (entries === undefined) return []
  const portOpen = deps.portOpen ?? ((port: number) => isPortOpen('127.0.0.1', port))
  const homeOf = deps.homeOf ?? readProcessHome
  const found = new Map<number, DetectedDsh>()
  for (const entry of entries) {
    if (entry.pid === process.pid || excludePids.has(entry.pid)) continue
    const parsed = parseDshServerCommand(entry.command)
    if (parsed === undefined) continue
    if (configuredPorts.has(parsed.port) || found.has(parsed.port)) continue
    if (!(await portOpen(parsed.port))) continue
    found.set(parsed.port, {
      pid: entry.pid,
      port: parsed.port,
      profile: parsed.profile,
      home: homeOf(entry.pid),
      command: entry.command,
    })
  }
  return [...found.values()].sort((left, right) => left.port - right.port)
}

/** The newest launch token in a log-like text, or undefined. */
export function newestLaunchToken(text: string): string | undefined {
  let token: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const match = /[?&]token=([A-Za-z0-9_-]{8,})/.exec(line)
    if (match !== null) token = match[1]
  }
  return token
}

/** The process entry serving `port`, if the process list shows one. */
export function findDshServerEntry(entries: readonly ProcessEntry[], port: number): ProcessEntry | undefined {
  return entries.find((entry) => parseDshServerCommand(entry.command)?.port === port)
}
