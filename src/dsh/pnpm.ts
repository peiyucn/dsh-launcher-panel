import * as fs from 'node:fs'
import * as path from 'node:path'
import { runFile } from '../shared/proc.ts'
import { PNPM_PROBE_TIMEOUT_MS } from '../shared/timing.ts'

export function windowsPnpmCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'pnpm.cmd'))
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'pnpm', 'pnpm.cmd'))
  return out
}

// Spawn on Windows appends only .exe (never PATHEXT) and `where` lists the extensionless shim
// first, so answer with a launchable entry rather than the bare name.
export function pickPnpmFromPath(matches: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
  const usable = matches.map((match) => match.trim()).filter(Boolean)
  if (platform !== 'win32') return usable[0]
  return usable.find((match) => /\.exe$/i.test(match)) ?? usable.find((match) => /\.(cmd|bat)$/i.test(match))
}

let pnpmResolution: Promise<string | undefined> | undefined

// Cached for the session because resolving it spawns where/which and the panel polls repeatedly.
export function findPnpm(refresh = false): Promise<string | undefined> {
  if (refresh) pnpmResolution = undefined
  pnpmResolution ??= (async () => {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const result = await runFile(which, ['pnpm'], PNPM_PROBE_TIMEOUT_MS)
    const matches = result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
    const picked = pickPnpmFromPath(matches)
    if (picked !== undefined) return picked
    if (process.platform !== 'win32') return undefined
    for (const candidate of windowsPnpmCandidates(process.env)) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        continue
      }
    }
    return undefined
  })()
  return pnpmResolution
}

export function pnpmSupportsDangerouslyAllowAllBuilds(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim())
  return m !== null && (Number(m[1]) > 10 || (Number(m[1]) === 10 && Number(m[2]) >= 16))
}
