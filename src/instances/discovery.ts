import * as fs from 'node:fs'
import { isPortOpen } from '../dsh/probes.ts'
import { listProcessEntries, parseDshServerCommand, type ProcessLister } from './process-list.ts'

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
