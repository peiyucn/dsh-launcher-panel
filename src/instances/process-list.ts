import { execFile } from 'node:child_process'
import { decodeChildOutput } from '../shared/proc.ts'
import { NODE_PROBE_TIMEOUT_MS } from '../shared/timing.ts'

/** One process as reported by the platform's process list. */
export interface ProcessEntry {
  pid: number
  command: string
}

const WINDOWS_PROCESS_SCRIPT = 'Get-CimInstance Win32_Process '
  + '| ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }'

// Command lines can be long (source mode debug flags, deep checkout paths); keep headroom.
const PROCESS_LIST_MAX_BUFFER = 16 * 1024 * 1024

/** True when the argv token is a dsh CLI entry (global shim, installed bin.js or source entry). */
export function isDshEntryToken(token: string): boolean {
  const trimmed = token.replace(/^["']|["']$/g, '')
  // Require a path separator: a bare `dsh` argument (e.g. `pnpm exec dsh ...`) is not the entry.
  if (/[\\/]dsh$/i.test(trimmed) || /[\\/]dsh\.(?:js|cjs|mjs|cmd)$/i.test(trimmed)) return true
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin(?:\.js)?$/i.test(trimmed)) return true
  return /apps[\\/]cli[\\/](?:src|dist)[\\/]bin\.(?:ts|js)$/i.test(trimmed)
}

/** The dsh CLI entry token (a path) from a command line. */
export function dshEntryToken(command: string): string | undefined {
  const tokens = command.replace(/["']/g, '').split(/\s+/).filter((token) => token !== '')
  return tokens.find(isDshEntryToken)
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

/** True when `command` starts a dsh web server for exactly this port. */
export function isDshServerCommand(command: string, port: number): boolean {
  return parseDshServerCommand(command)?.port === port
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

/** The process entry serving `port`, if the process list shows a dsh server there. */
export function findDshServerEntry(entries: readonly ProcessEntry[], port: number): ProcessEntry | undefined {
  return entries.find((entry) => isDshServerCommand(entry.command, port))
}

/** PIDs of the dsh servers that serve `port`, deduplicated. */
export function findDshServerPids(entries: readonly ProcessEntry[], port: number): number[] {
  const pids = new Set<number>()
  for (const entry of entries) {
    if (isDshServerCommand(entry.command, port)) pids.add(entry.pid)
  }
  return [...pids]
}

/** PIDs of the DSH servers serving `port`; empty when the platform cannot tell. */
export async function findDshServerPidsByPort(port: number): Promise<number[]> {
  const entries = await listProcessEntries()
  return entries === undefined ? [] : findDshServerPids(entries, port)
}
