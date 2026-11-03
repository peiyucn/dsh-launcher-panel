import * as fs from 'node:fs'
import { runFile } from '../shared/proc.ts'
import { readLogTailBytes } from '../shared/logs.ts'
import { listProcessEntries, newestLaunchToken, parseDshServerCommand, type ProcessEntry } from './discovery.ts'

/** A supervisor command is local; a hung journalctl/docker must not stall the panel. */
const TOKEN_COMMAND_TIMEOUT_MS = 10_000

/** Tokens stay valid for the life of one dsh process; short cache avoids per-refresh commands. */
const TOKEN_CACHE_TTL_MS = 60_000

const TOKEN_LOG_LINES = '500'

export interface ObservedTokenResult {
  token?: string
  error?: string
}

export type SupervisorSource =
  | { kind: 'systemd'; unit: string }
  | { kind: 'docker'; container: string }

export interface TokenDeps {
  platform?: NodeJS.Platform
  list?: () => Promise<ProcessEntry[] | undefined>
  run?: typeof runFile
  readTail?: (file: string) => string | undefined
  readCgroup?: (pid: number) => string | undefined
  readStdoutTarget?: (pid: number) => string | undefined
}

/** Parse a Linux cgroup line into the supervisor that owns the process. */
export function parseCgroupSource(cgroup: string): SupervisorSource | undefined {
  // /proc/<pid>/cgroup ends with a newline; a trailing newline must not defeat the match.
  const line = cgroup.trim()
  const unit = /(?:^|\/)([^/\n]+\.service)(?:\/|$)/.exec(line)?.[1]
  if (unit !== undefined) return { kind: 'systemd', unit }
  const container = /docker[/-]([0-9a-f]{12,64})/i.exec(line)?.[1]
  if (container !== undefined) return { kind: 'docker', container }
  return undefined
}

function defaultReadCgroup(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')
  } catch {
    return undefined
  }
}

function defaultReadStdoutTarget(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    return fs.readlinkSync(`/proc/${pid}/fd/1`)
  } catch {
    return undefined
  }
}

/** The dsh server pid serving `port` (first command-line match). */
export function findDshPidByPort(entries: readonly ProcessEntry[], port: number): number | undefined {
  for (const entry of entries) {
    const parsed = parseDshServerCommand(entry.command)
    if (parsed !== undefined && parsed.port === port) return entry.pid
  }
  return undefined
}

async function tokenFromSupervisor(cgroup: string, deps: TokenDeps): Promise<ObservedTokenResult> {
  const source = parseCgroupSource(cgroup)
  if (source === undefined) {
    return { error: 'the process has no systemd unit or docker container to read a launch token from' }
  }
  const run = deps.run ?? runFile
  const command = source.kind === 'systemd' ? 'journalctl' : 'docker'
  const args = source.kind === 'systemd'
    ? ['-u', source.unit, '-n', TOKEN_LOG_LINES, '--no-pager', '--output=cat']
    : ['logs', '--tail', TOKEN_LOG_LINES, source.container]
  const result = await run(command, args, TOKEN_COMMAND_TIMEOUT_MS)
  if (!result.ok) {
    const detail = result.error?.trim() === '' || result.error === undefined ? 'command failed' : result.error
    const label = source.kind === 'systemd' ? `journal for ${source.unit}` : `logs for container ${source.container}`
    return { error: `could not read ${label}: ${detail}` }
  }
  const token = newestLaunchToken(result.stdout)
  return token === undefined
    ? { error: `${labelTokenSource(source)} output does not contain a dsh launch token` }
    : { token }
}

function labelTokenSource(source: SupervisorSource): string {
  return source.kind === 'systemd' ? `journal of ${source.unit}` : `logs of container ${source.container}`
}

/** Resolve the launch token for an observed dsh process id. */
export async function tokenForPid(pid: number, deps: TokenDeps = {}): Promise<ObservedTokenResult> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'linux') {
    return { error: 'automatic launch-token lookup is only available on Linux (systemd or docker)' }
  }
  const readCgroup = deps.readCgroup ?? defaultReadCgroup
  const cgroup = readCgroup(pid)
  if (cgroup !== undefined) {
    const fromSupervisor = await tokenFromSupervisor(cgroup, deps)
    if (fromSupervisor.token !== undefined) return fromSupervisor
    // A supervisor that cannot answer still leaves the stdout-file fallback worth trying.
    const fromFile = await tokenFromStdoutFile(pid, deps)
    return fromFile.token !== undefined ? fromFile : fromSupervisor
  }
  return tokenFromStdoutFile(pid, deps)
}

async function tokenFromStdoutFile(pid: number, deps: TokenDeps): Promise<ObservedTokenResult> {
  const readStdoutTarget = deps.readStdoutTarget ?? defaultReadStdoutTarget
  const target = readStdoutTarget(pid)
  if (target === undefined || target.startsWith('socket:') || target.startsWith('pipe:') || target.startsWith('/dev/')) {
    return { error: 'the process does not log to a readable file' }
  }
  const readTail = deps.readTail ?? ((file: string) => readLogTailBytes(file))
  const text = readTail(target)
  if (text === undefined) return { error: `the process log file ${target} could not be read` }
  const token = newestLaunchToken(text)
  return token === undefined ? { error: `the process log file ${target} has no launch token` } : { token }
}

const cache = new Map<string, { token?: string; error?: string; at: number }>()

/** Test seam: forget cached tokens (also useful after a 401). */
export function clearObservedTokenCache(): void {
  cache.clear()
}

/**
 * Resolve the launch token of the dsh server on `port`, caching the result briefly.
 * Returns an error instead of throwing; the caller surfaces it as the instance error.
 */
export async function resolveObservedToken(port: number, deps: TokenDeps = {}): Promise<ObservedTokenResult> {
  const key = `${deps.platform ?? process.platform}:${port}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) {
    return cached.token !== undefined ? { token: cached.token } : { error: cached.error }
  }
  const entries = await (deps.list ?? listProcessEntries)()
  const pid = entries === undefined ? undefined : findDshPidByPort(entries, port)
  if (pid === undefined) {
    const result = { error: `no dsh process is serving 127.0.0.1:${port}` }
    cache.set(key, { ...result, at: Date.now() })
    return result
  }
  const result = await tokenForPid(pid, deps)
  cache.set(key, { ...(result.token === undefined ? {} : { token: result.token }), ...(result.error === undefined ? {} : { error: result.error }), at: Date.now() })
  return result
}
