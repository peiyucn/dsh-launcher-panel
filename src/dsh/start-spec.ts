import * as path from 'node:path'
import { DSH_NO_OPEN_MIN_VERSION, dshVersionAtLeast } from './versions.ts'

interface CommandTarget {
  mode: 'pnpm' | 'source'
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

function buildCommand(input: CommandBuild): SpawnSpecResult {
  const { env, args } = input
  if (input.mode === 'pnpm') {
    if (!input.installDir) return { ok: false, reason: input.missingPnpm }
    return {
      ok: true,
      spec: {
        file: input.nodePath || 'node',
        // pnpm owns installation, not the hot start path: invoking its CLI adds another
        // package-manager startup and dependency check before the actual dsh process.
        args: [path.join(input.installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), ...args],
        cwd: input.installDir,
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
    missingPnpm: 'pkg start has no dsh install',
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
