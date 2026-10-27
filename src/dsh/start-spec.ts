import { DSH_NO_OPEN_MIN_VERSION, dshVersionAtLeast } from './versions.ts'
import { resolveCommandEntry, type ResolvedCommand } from '../shared/proc.ts'

interface CommandTarget {
  mode: 'pnpm' | 'source'
  pnpmCmd?: string
  installDir?: string
  checkout?: string
}

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export type SpawnSpecResult =
  | { ok: true; spec: SpawnSpec }
  | { ok: false; reason: string }

export interface SpawnSpecInput extends CommandTarget {
  version: string
  profile: string
  port: number
  home: string
  nodePath: string
  sourceDebug: boolean
  baseEnv?: NodeJS.ProcessEnv
}

export interface ProfileInitSpecInput extends CommandTarget {
  profile: string
  home: string
  nodePath: string
  baseEnv?: NodeJS.ProcessEnv
}

function instanceEnv(baseEnv: NodeJS.ProcessEnv | undefined, home: string): NodeJS.ProcessEnv {
  return { ...(baseEnv ?? process.env), DSH_HOME: home }
}

function instanceArgs(profile: string, port: number, version: string): string[] {
  const args = [profile, '--port', String(port)]
  // Older dsh rejects the flag instead of ignoring it.
  if (version !== '' && dshVersionAtLeast(version, DSH_NO_OPEN_MIN_VERSION)) args.push('--no-open')
  return args
}

function profileInitArgs(profile: string): string[] {
  return profile === 'web'
    ? ['web', '--dump-config']
    : ['--profile', profile, '--from-default-profile', 'web', '--dump-config']
}

interface CommandBuild extends CommandTarget {
  nodePath: string
  env: NodeJS.ProcessEnv
  args: string[]
  missingPnpm: string
  missingSource: string
}

function resolvePnpm(pnpmCmd: string | undefined, installDir: string | undefined, missingReason: string): { ok: true; command: ResolvedCommand; installDir: string } | { ok: false; reason: string } {
  if (!pnpmCmd || !installDir) return { ok: false, reason: missingReason }
  const resolution = resolveCommandEntry(pnpmCmd)
  if (!resolution.ok) return { ok: false, reason: `pnpm cannot be launched (${resolution.reason})` }
  return { ok: true, command: resolution.command, installDir }
}

function buildCommand(input: CommandBuild): SpawnSpecResult {
  const { env, args } = input
  if (input.mode === 'pnpm') {
    const pnpm = resolvePnpm(input.pnpmCmd, input.installDir, input.missingPnpm)
    if (!pnpm.ok) return pnpm
    return {
      ok: true,
      spec: {
        file: pnpm.command.file,
        // The launcher owns installs; pnpm exec must not re-install on its own.
        args: [...pnpm.command.args, '--config.verify-deps-before-run=false', 'exec', 'dsh', ...args],
        cwd: pnpm.installDir,
        env,
      },
    }
  }
  if (!input.checkout) return { ok: false, reason: input.missingSource }
  return {
    ok: true,
    spec: {
      file: input.nodePath || 'node',
      args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args],
      cwd: input.checkout,
      env,
    },
  }
}

export function buildSpawnSpec(input: SpawnSpecInput): SpawnSpecResult {
  const env = instanceEnv(input.baseEnv, input.home)
  if (input.mode === 'source' && input.sourceDebug) env.NODE_DEBUG = 'module'
  return buildCommand({
    ...input,
    env,
    args: instanceArgs(input.profile, input.port, input.version),
    missingPnpm: 'pkg start has no pnpm install',
    missingSource: 'source start has no checkout',
  })
}

export function buildProfileInitSpec(input: ProfileInitSpecInput): SpawnSpecResult {
  return buildCommand({
    ...input,
    env: instanceEnv(input.baseEnv, input.home),
    args: profileInitArgs(input.profile),
    missingPnpm: 'profile initialization needs a pnpm install',
    missingSource: 'profile initialization needs a source checkout',
  })
}
