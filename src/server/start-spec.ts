/**
 * Pure construction of the commands that start one instance.
 *
 * Two spawn shapes share one launcher: pkg mode resolves the pnpm shim and runs
 * `pnpm … exec dsh`, source mode runs the checkout's CLI through tsx. Both take
 * the instance's `DSH_HOME`, profile and port as arguments/environment — never
 * concatenated into a shell line (see `server/process.ts` for why).
 *
 * Kept free of VS Code APIs so the argument/environment contract is unit-tested
 * instead of only observed at runtime (spec §14).
 *
 * @module server/start-spec
 */

import { DSH_NO_OPEN_MIN_VERSION, dshVersionAtLeast } from '../versions.ts'
import { resolveCommandEntry, type ResolvedCommand } from '../proc.ts'

/** What the shared install layer prepared for a start. */
export interface StartInstall {
  mode: 'pnpm' | 'source'
  version: string
  /** pnpm command for pkg mode (may be a `.cmd` shim; resolved before spawning). */
  pnpmCmd?: string
  /** Managed package directory for pkg mode. */
  installDir?: string
  /** Source checkout for source mode. */
  checkout?: string
}

/** One command that can be spawned directly, without a shell. */
export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** The built command, or the reason it cannot be built (reported verbatim). */
export type SpawnSpecResult =
  | { ok: true; spec: SpawnSpec }
  | { ok: false; reason: string }

/** Input for the server start command. */
export interface SpawnSpecInput extends StartInstall {
  profile: string
  port: number
  /** Effective DSH_HOME for this instance. */
  home: string
  /** The configured Node executable; empty means PATH's `node`. */
  nodePath: string
  /** Print module-loading progress (source mode only; dsh.sourceDebug). */
  sourceDebug: boolean
  /** Base environment; process.env in production, injected in tests. */
  baseEnv?: NodeJS.ProcessEnv
}

/** Input for the one-shot profile initialization command (`--dump-config`). */
export interface ProfileInitSpecInput {
  mode: 'pnpm' | 'source'
  pnpmCmd?: string
  installDir?: string
  checkout?: string
  profile: string
  /** Effective DSH_HOME for this instance. */
  home: string
  /** The configured Node executable; empty means PATH's `node`. */
  nodePath: string
  /** Base environment; process.env in production, injected in tests. */
  baseEnv?: NodeJS.ProcessEnv
}

/** The instance environment: the launcher's own plus this instance's DSH_HOME. */
function instanceEnv(baseEnv: NodeJS.ProcessEnv | undefined, home: string): NodeJS.ProcessEnv {
  return { ...(baseEnv ?? process.env), DSH_HOME: home }
}

/**
 * The `dsh <profile> --port <port>` tail.
 *
 * `--no-open` tells dsh not to launch a browser itself: the launcher opens the
 * Web UI in the requested browser (dsh.browser) after the port is ready. Older
 * dsh versions do not understand the flag, hence the version gate.
 */
function instanceArgs(profile: string, port: number, version: string): string[] {
  const args = [profile, '--port', String(port)]
  if (version !== '' && dshVersionAtLeast(version, DSH_NO_OPEN_MIN_VERSION)) args.push('--no-open')
  return args
}

/**
 * The arguments that make dsh compose a profile and exit (`--dump-config`).
 *
 * `web` is the built-in profile name accepted as a subcommand; any other
 * profile is created from the `web` template.
 */
function profileInitArgs(profile: string): string[] {
  return profile === 'web'
    ? ['web', '--dump-config']
    : ['--profile', profile, '--from-default-profile', 'web', '--dump-config']
}

/** Resolve the pnpm command, reporting the caller-specific "not prepared" reason. */
function resolvePnpm(
  pnpmCmd: string | undefined,
  installDir: string | undefined,
  missingReason: string,
): { ok: true; command: ResolvedCommand; installDir: string } | { ok: false; reason: string } {
  if (!pnpmCmd || !installDir) return { ok: false, reason: missingReason }
  const resolution = resolveCommandEntry(pnpmCmd)
  if (!resolution.ok) return { ok: false, reason: `pnpm cannot be launched (${resolution.reason})` }
  return { ok: true, command: resolution.command, installDir }
}

/** Build the command that runs the instance's DSH web server. */
export function buildSpawnSpec(input: SpawnSpecInput): SpawnSpecResult {
  const env = instanceEnv(input.baseEnv, input.home)
  if (input.mode === 'source' && input.sourceDebug) env.NODE_DEBUG = 'module'
  const args = instanceArgs(input.profile, input.port, input.version)

  if (input.mode === 'pnpm') {
    const pnpm = resolvePnpm(input.pnpmCmd, input.installDir, 'pkg start has no pnpm install')
    if (!pnpm.ok) return pnpm
    return {
      ok: true,
      spec: {
        file: pnpm.command.file,
        args: [...pnpm.command.args, '--config.verify-deps-before-run=false', 'exec', 'dsh', ...args],
        cwd: pnpm.installDir,
        env,
      },
    }
  }

  if (!input.checkout) return { ok: false, reason: 'source start has no checkout' }
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

/** Build the one-shot command that creates the instance profile. */
export function buildProfileInitSpec(input: ProfileInitSpecInput): SpawnSpecResult {
  const env = instanceEnv(input.baseEnv, input.home)
  const args = profileInitArgs(input.profile)

  if (input.mode === 'pnpm') {
    const pnpm = resolvePnpm(input.pnpmCmd, input.installDir, 'profile initialization needs a pnpm install')
    if (!pnpm.ok) return pnpm
    return {
      ok: true,
      spec: {
        file: pnpm.command.file,
        args: [...pnpm.command.args, '--config.verify-deps-before-run=false', 'exec', 'dsh', ...args],
        cwd: pnpm.installDir,
        env,
      },
    }
  }

  if (!input.checkout) return { ok: false, reason: 'profile initialization needs a source checkout' }
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
