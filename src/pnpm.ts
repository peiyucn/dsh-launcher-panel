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

/** Every PATH match for a command (`where`/`which` print one per line). */
async function findOnPath(cmd: string): Promise<string[]> {
  const which = process.platform === 'win32' ? 'where' : 'which'
  const result = await runFile(which, [cmd], PNPM_PROBE_TIMEOUT_MS)
  if (!result.ok) return []
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

/**
 * Choose, from the PATH matches, the one this launcher can actually **launch**.
 *
 * ⚠️ This is the whole reason `findPnpm` must not answer with a bare name.
 * On Windows `pnpm` is installed as three files in the npm prefix, and `where`
 * lists the **extensionless** POSIX-style shim first:
 *
 * ```
 * C:\…\npm\pnpm          ← 无扩展名：既不是 .exe 也不是 .cmd
 * C:\…\npm\pnpm.cmd      ← 真正能在 cmd 里跑的那个
 * ```
 *
 * `spawn` on Windows does **not** expand `PATHEXT` — it only appends `.exe` —
 * so spawning the bare, extensionless name fails with `ENOENT` (measured:
 * `spawn('pnpm', ['--version'])` → `ENOENT`). A bare name also slips past
 * `resolveCommand`, whose shim-unwrapping only triggers for `.cmd`/`.bat`, so
 * the failure is silent: `child.pid` is `undefined` and the panel reports
 * "no process id was reported" with an empty server log.
 *
 * So: prefer a real `.exe` (launchable as-is), then a `.cmd`/`.bat` shim
 * (`resolveCommand` unwraps it into `node <entry>`), and only then nothing.
 *
 * @param matches - PATH matches, in `where` order.
 * @param platform - defaults to `process.platform`; injectable so the Windows
 *   branch is testable on any host.
 * @returns a launchable path, or undefined when none of them can be launched.
 */
export function pickPnpmFromPath(matches: readonly string[], platform: NodeJS.Platform = process.platform): string | undefined {
  const usable = matches.map((match) => match.trim()).filter(Boolean)
  if (platform !== 'win32') return usable[0]
  return usable.find((path) => /\.exe$/i.test(path))
    ?? usable.find((path) => /\.(cmd|bat)$/i.test(path))
}

/**
 * Resolve the pnpm command: the **launchable** PATH match first, then the known
 * Windows shim locations.
 *
 * The returned value is always something `resolveCommand`/`spawn` can run — a
 * full path, never a bare name (see `pickPnpmFromPath` for why that matters).
 */
export async function findPnpm(): Promise<string | undefined> {
  const picked = pickPnpmFromPath(await findOnPath('pnpm'))
  if (picked !== undefined) return picked
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
