import { execFile } from 'node:child_process'
import { decodeChildOutput } from '../shared/proc.ts'
import { NODE_PROBE_TIMEOUT_MS } from '../shared/timing.ts'

export interface ProcessEntry {
  pid: number
  command: string
}

const WINDOWS_PROCESS_SCRIPT = 'Get-CimInstance Win32_Process '
  + '| ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }'

const PROCESS_LIST_MAX_BUFFER = 16 * 1024 * 1024

export function isDshEntryToken(token: string): boolean {
  const trimmed = token.replace(/^["']|["']$/g, '')

  if (/[\\/]dsh$/i.test(trimmed) || /[\\/]dsh\.(?:js|cjs|mjs|cmd)$/i.test(trimmed)) return true
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin(?:\.js)?$/i.test(trimmed)) return true
  return /apps[\\/]cli[\\/](?:src|dist)[\\/]bin\.(?:ts|js)$/i.test(trimmed)
}

export function dshEntryToken(command: string): string | undefined {
  const tokens = command.replace(/["']/g, '').split(/\s+/).filter((token) => token !== '')
  return tokens.find(isDshEntryToken)
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

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

export function isDshServerCommand(command: string, port: number): boolean {
  return parseDshServerCommand(command)?.port === port
}

function parsePid(text: string): number | undefined {
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

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

export function findDshServerEntry(entries: readonly ProcessEntry[], port: number): ProcessEntry | undefined {
  return entries.find((entry) => isDshServerCommand(entry.command, port))
}

export function findDshServerPids(entries: readonly ProcessEntry[], port: number): number[] {
  const pids = new Set<number>()
  for (const entry of entries) {
    if (isDshServerCommand(entry.command, port)) pids.add(entry.pid)
  }
  return [...pids]
}

export async function findDshServerPidsByPort(port: number): Promise<number[]> {
  const entries = await listProcessEntries()
  return entries === undefined ? [] : findDshServerPids(entries, port)
}
