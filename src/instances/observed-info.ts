import * as fs from 'node:fs'
import * as path from 'node:path'
import { dshEntryToken, findDshServerEntry, listProcessEntries, type ProcessEntry } from './discovery.ts'

/** Information about the dsh installation behind an observed (externally started) server. */
export interface ObservedInstallInfo {
  /** Absolute path of the dsh CLI entry, when it could be resolved. */
  entryPath?: string
  /** Package root (directory with the dsh package.json), when it could be found. */
  packagePath?: string
  version?: string
  command?: string
}

export interface ObservedInstallDeps {
  list?: () => Promise<ProcessEntry[] | undefined>
  realpath?: (file: string) => string | undefined
  readFile?: (file: string) => string | undefined
}

const CACHE_TTL_MS = 30_000

const cache = new Map<number, { info: ObservedInstallInfo; at: number }>()

export function clearObservedInstallCache(): void {
  cache.clear()
}

function defaultRealpath(file: string): string | undefined {
  try {
    return fs.realpathSync(file)
  } catch {
    return undefined
  }
}

function defaultReadFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Walk up from the entry file to the nearest package.json that describes dsh. */
export function findDshPackageJson(
  entryPath: string,
  deps: Pick<ObservedInstallDeps, 'realpath' | 'readFile'> = {},
): { packagePath: string; version: string } | undefined {
  const realpath = deps.realpath ?? defaultRealpath
  const readFile = deps.readFile ?? defaultReadFile
  const resolved = realpath(entryPath) ?? entryPath
  let dir = path.dirname(resolved)
  for (let depth = 0; depth < 8; depth++) {
    const manifestFile = path.join(dir, 'package.json')
    const text = readFile(manifestFile)
    if (text !== undefined) {
      try {
        const manifest = JSON.parse(text) as { name?: unknown; version?: unknown }
        const name = typeof manifest.name === 'string' ? manifest.name : ''
        const version = typeof manifest.version === 'string' ? manifest.version : ''
        if (version !== '' && /(?:^|\/)dsh(?:$|-)|deepseek-harness/.test(name)) {
          return { packagePath: dir, version }
        }
      } catch {
        // Keep walking; a malformed package.json is not this lookup's failure.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function readObservedInstall(
  entries: readonly ProcessEntry[],
  port: number,
  deps: Pick<ObservedInstallDeps, 'realpath' | 'readFile'>,
): ObservedInstallInfo {
  const entry = findDshServerEntry(entries, port)
  if (entry === undefined) return {}
  const token = dshEntryToken(entry.command)
  if (token === undefined) return { command: entry.command }
  const entryPath = path.isAbsolute(token) ? token : undefined
  const pkg = entryPath === undefined ? undefined : findDshPackageJson(entryPath, deps)
  return {
    ...entryPath === undefined ? {} : { entryPath },
    ...pkg === undefined ? {} : { packagePath: pkg.packagePath, version: pkg.version },
    command: entry.command,
  }
}

/** Resolve the installation behind the dsh serving `port` (cached briefly). */
export async function resolveObservedInstall(port: number, deps: ObservedInstallDeps = {}): Promise<ObservedInstallInfo> {
  const cached = cache.get(port)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.info
  const entries = await (deps.list ?? listProcessEntries)()
  const info = entries === undefined ? {} : readObservedInstall(entries, port, deps)
  cache.set(port, { info, at: Date.now() })
  return info
}
