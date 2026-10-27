import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { decodeChildOutput } from '../../shared/proc.ts'
import { buildProfileInitSpec } from '../../dsh/start-spec.ts'
import type { DshInstance } from '../model.ts'
import type { PreparedDsh } from './types.ts'

const PROFILE_INIT_TIMEOUT_MS = 180_000

export interface ProfileHooks {
  activity(line: string): void
  fail(message: string): false
  nodePath(): string
}

function runInitCommand(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      env,
      windowsHide: true,
      timeout: PROFILE_INIT_TIMEOUT_MS,
      encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = `${decodeChildOutput(stdout ?? Buffer.alloc(0))}\n${decodeChildOutput(stderr ?? Buffer.alloc(0))}`.trim()
      if (!error) {
        resolve({ ok: true, output })
        return
      }
      const timedOut = (error as { killed?: boolean }).killed === true
      resolve({ ok: false, output: `${timedOut ? 'timed out' : error.message}\n${output}`.trim() })
    })
  })
}

/** DSH owns profile creation: `--dump-config` composes the tree and exits. */
export async function ensureProfile(
  instance: DshInstance,
  prepared: PreparedDsh,
  home: string,
  hooks: ProfileHooks,
): Promise<boolean> {
  const profileDir = path.join(home, 'profiles', instance.profile)
  if (fs.existsSync(profileDir)) return true
  hooks.activity(`ℹ Initializing profile "${instance.profile}" in ${home}…`)
  const built = buildProfileInitSpec({
    ...prepared,
    profile: instance.profile,
    home,
    nodePath: hooks.nodePath(),
    baseEnv: process.env,
  })
  if (!built.ok) return hooks.fail(built.reason)
  const result = await runInitCommand(built.spec.file, built.spec.args, built.spec.cwd, built.spec.env)
  if (!result.ok || !fs.existsSync(profileDir)) {
    return hooks.fail(`profile initialization failed: ${result.output.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || 'no output'}`)
  }
  hooks.activity(`✓ Profile "${instance.profile}" initialized`)
  return true
}
