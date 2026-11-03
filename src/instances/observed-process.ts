import * as fs from 'node:fs'
import * as path from 'node:path'
import { dshEntryToken, findDshServerEntry, listProcessEntries, type ProcessEntry, type ProcessLister } from './process-list.ts'
import { tokenForPid, type TokenDeps } from './observed-token.ts'

/** Everything the panel knows about the external process behind a detected instance. */
export interface ObservedProcessInfo {
  pid?: number
  command?: string
  /** Absolute path of the dsh CLI entry, when it could be resolved. */
  entryPath?: string
  /** Package root (directory with the dsh package.json), when it could be found. */
  packagePath?: string
  version?: string
  token?: string
  tokenError?: string
}

export interface ObservedProcessDeps {
  list?: ProcessLister
  realpath?: (file: string) => string | undefined
  readFile?: (file: string) => string | undefined
  token?: TokenDeps
}

const CACHE_TTL_MS = 30_000

const cache = new Map<number, { info: ObservedProcessInfo; at: number }>()

export function clearObservedProcessCache(): void {
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
  deps: Pick<ObservedProcessDeps, 'realpath' | 'readFile'> = {},
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

async function readObservedProcess(
  entries: readonly ProcessEntry[],
  port: number,
  deps: ObservedProcessDeps,
): Promise<ObservedProcessInfo> {
  const entry = findDshServerEntry(entries, port)
  if (entry === undefined) {
    return { tokenError: `no dsh process is serving 127.0.0.1:${port}` }
  }
  const token = await tokenForPid(entry.pid, deps.token ?? {})
  const tokenPath = dshEntryToken(entry.command)
  const entryPath = tokenPath !== undefined && path.isAbsolute(tokenPath) ? tokenPath : undefined
  const pkg = entryPath === undefined ? undefined : findDshPackageJson(entryPath, deps)
  return {
    pid: entry.pid,
    command: entry.command,
    ...entryPath === undefined ? {} : { entryPath },
    ...pkg === undefined ? {} : { packagePath: pkg.packagePath, version: pkg.version },
    ...token.token === undefined ? {} : { token: token.token },
    ...token.error === undefined ? {} : { tokenError: token.error },
  }
}

/**
 * Resolve pid, package path/version and launch token of the dsh serving `port` in one
 * process-list pass (cached briefly). Returns an error instead of throwing.
 */
export async function resolveObservedProcess(
  port: number,
  deps: ObservedProcessDeps = {},
): Promise<ObservedProcessInfo> {
  const cached = cache.get(port)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.info
  const entries = await (deps.list ?? listProcessEntries)()
  const info = entries === undefined
    ? { tokenError: 'the process list is not available on this platform' }
    : await readObservedProcess(entries, port, deps)
  cache.set(port, { info, at: Date.now() })
  return info
}
