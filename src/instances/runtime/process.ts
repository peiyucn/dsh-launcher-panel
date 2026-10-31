import { execFile } from 'node:child_process'
import { NODE_PROBE_TIMEOUT_MS, TASKKILL_TIMEOUT_MS } from '../../shared/timing.ts'
import { decodeChildOutput } from '../../shared/proc.ts'

/** One process as reported by the platform's process list. */
export interface ProcessEntry {
  pid: number
  command: string
}

// The dsh server is the node process the launcher spawned: pkg mode runs the installed
// `@deepseek-ai/dsh/lib/bin.js`, source mode runs the checkout's `apps/cli/src/bin.ts`.
// Resolving the owner through the socket table is unreliable: some Windows machines report
// listening sockets with PID 0, so `netstat -ano` cannot say who holds the port.
const DSH_ENTRY_PATTERN = /(?:@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin(?:\.js)?|apps[\\/]cli[\\/]src[\\/]bin\.ts)/i

// A CIM query returns all node processes, command lines included, as `<pid>\t<command line>`.
const WINDOWS_PROCESS_SCRIPT = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" '
  + '| ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }'

// Command lines can be long (source mode debug flags, deep checkout paths); keep headroom.
const PROCESS_LIST_MAX_BUFFER = 8 * 1024 * 1024

function execText(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: PROCESS_LIST_MAX_BUFFER }, (error, stdout) => {
      resolve(error ? undefined : stdout)
    })
  })
}

function parsePid(text: string): number | undefined {
  const pid = Number(text)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** Windows CIM probe output: one `<pid>\t<command line>` row per node process. */
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

/**
 * True when `command` starts a dsh web server for exactly this port.
 *
 * Windows passes the launcher's argv with quotes (`"--port" "3080"`), so quotes are dropped
 * before the port token is matched. The dsh entry marker keeps an unrelated `--port <n>`
 * process (a dev server on the same port) from being mistaken for the instance's server.
 */
export function isDshServerCommand(command: string, port: number): boolean {
  if (!DSH_ENTRY_PATTERN.test(command)) return false
  const unquoted = command.replace(/["']/g, '')
  return new RegExp(`(?:^|\\s)--port(?:\\s+|=)${port}(?=$|\\s)`).test(unquoted)
}

/** PIDs of the dsh servers that serve `port`, deduplicated. */
export function findDshServerPids(entries: readonly ProcessEntry[], port: number): number[] {
  const pids = new Set<number>()
  for (const entry of entries) {
    if (isDshServerCommand(entry.command, port)) pids.add(entry.pid)
  }
  return [...pids]
}

async function listProcesses(): Promise<ProcessEntry[] | undefined> {
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

/** PIDs of the DSH servers serving `port`; empty when the platform cannot tell. */
export async function findDshServerPidsByPort(port: number): Promise<number[]> {
  const entries = await listProcesses()
  return entries === undefined ? [] : findDshServerPids(entries, port)
}

/**
 * Kill one process tree. Resolves after `taskkill` exits (Windows) or the signal is sent, so
 * the caller can wait for the port to close instead of racing a fire-and-forget kill.
 */
export function killPid(pid: number, dbg: (line: string) => void): Promise<boolean> {
  // Never let a bad lookup (e.g. the PID 0 a socket table may report) terminate the launcher
  // itself or a kernel process.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    dbg(`refused to kill invalid pid ${pid}`)
    return Promise.resolve(false)
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      // encoding: 'buffer' preserves taskkill's localized (e.g. GBK) message.
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true, timeout: TASKKILL_TIMEOUT_MS, encoding: 'buffer',
      }, (error, _stdout, stderr) => {
        if (!error) {
          resolve(true)
          return
        }
        const detail = decodeChildOutput(stderr ?? Buffer.alloc(0)).trim().split(/\r?\n/).filter((line) => line.trim() !== '').join(' ')
        dbg(`taskkill ${pid} failed: ${detail || error.message}`)
        resolve(false)
      })
    })
  }
  // POSIX: kill the whole group (detached spawn) so pnpm/node descendants release the port.
  try {
    process.kill(-pid)
    return Promise.resolve(true)
  } catch {
    // Not a group leader; fall back to the single pid.
  }
  try {
    process.kill(pid)
    return Promise.resolve(true)
  } catch {
    // Already exited.
    return Promise.resolve(false)
  }
}
