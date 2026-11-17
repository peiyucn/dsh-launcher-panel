import * as fs from 'node:fs'
import { isPortOpen } from '../dsh/probes.ts'
import { listProcessEntries, parseDshServerCommand, type ProcessLister } from './process-list.ts'

export interface DetectedDsh {
  pid: number
  port: number

  profile: string

  home: string
  command: string
}

export function readProcessHome(pid: number): string {
  if (process.platform !== 'linux') return ''
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
    for (const pair of env.split('\0')) {
      if (pair.startsWith('DSH_HOME=')) return pair.slice('DSH_HOME='.length)
    }
  } catch {
  }
  return ''
}

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
