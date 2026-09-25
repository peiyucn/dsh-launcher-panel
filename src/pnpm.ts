/**
 * Finding and describing the pnpm that the launcher drives.
 *
 * pnpm is the one external tool the launcher runs for its own purposes (dsh's
 * dependency management is pnpm's own). Resolving it is fiddlier on Windows,
 * where the executable is a `.cmd` shim rather than a POSIX script.
 *
 * @module pnpm
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { runFile } from './proc.ts'
import { PNPM_PROBE_TIMEOUT_MS } from './timing.ts'

/** Candidate pnpm.cmd shim locations on Windows (npm global bin, pnpm standalone installer). */
export function windowsPnpmCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'pnpm.cmd'))
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'pnpm', 'pnpm.cmd'))
  return out
}

/** Resolve a command on PATH (returns the first match, or undefined). */
async function findOnPath(cmd: string): Promise<string | undefined> {
  const which = process.platform === 'win32' ? 'where' : 'which'
  const result = await runFile(which, [cmd], PNPM_PROBE_TIMEOUT_MS)
  if (!result.ok) return undefined
  const first = result.stdout.trim().split(/\r?\n/)[0]
  return first || undefined
}

/**
 * Resolve the pnpm command: PATH first (bare `pnpm` on Windows, so cmd's
 * PATHEXT picks pnpm.cmd), then the known Windows shim locations.
 */
export async function findPnpm(): Promise<string | undefined> {
  const onPath = await findOnPath('pnpm')
  if (onPath) return process.platform === 'win32' ? 'pnpm' : onPath
  if (process.platform !== 'win32') return undefined
  for (const candidate of windowsPnpmCandidates(process.env)) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // unreadable location
    }
  }
  return undefined
}

/**
 * Whether a pnpm version (like '11.22.0') supports install's
 * --dangerously-allow-all-builds flag (pnpm ≥ 10.16), which approves
 * dependency build scripts non-interactively — the same thing npm does by
 * default on every install.
 */
export function pnpmSupportsDangerouslyAllowAllBuilds(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 10 || (major === 10 && minor >= 16)
}
