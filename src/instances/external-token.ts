import { extractWebToken } from '../shared/env.ts'
import { readLogTailBytes } from '../shared/logs.ts'
import { runFile } from '../shared/proc.ts'
import type { ExternalTokenSource } from './model.ts'

/** A token lookup is a local command; a hung journalctl/docker must not stall a refresh. */
const TOKEN_COMMAND_TIMEOUT_MS = 10_000

/** How many log lines the external supervisor's log is searched for the current token. */
const TOKEN_LOG_LINES = '500'

export interface ExternalTokenResult {
  token?: string
  error?: string
}

export type TokenRunner = (command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string; error?: string }>

export interface ExternalTokenDeps {
  platform?: NodeJS.Platform
  run?: TokenRunner
  readFileTail?: (file: string) => string | undefined
}

function newestToken(text: string): string | undefined {
  let token: string | undefined
  // The newest launch printed the token that is valid now.
  for (const line of text.split(/\r?\n/)) token = extractWebToken(line) ?? token
  return token
}

/**
 * Resolve dsh's launch token for an externally supervised instance.
 *
 * The launcher normally reads the token from its own server.log; when the process is owned by
 * systemd/docker/manual tooling it has no such log, so the token is read from the configured
 * source. Errors are returned instead of thrown: the caller shows them as an instance error.
 */
export async function resolveExternalToken(
  source: ExternalTokenSource | undefined,
  deps: ExternalTokenDeps = {},
): Promise<ExternalTokenResult> {
  if (source === undefined) {
    return { error: 'no tokenSource is configured for this external instance' }
  }
  if (source.kind === 'file') {
    const readTail = deps.readFileTail ?? ((file: string) => readLogTailBytes(file))
    const text = readTail(source.path)
    if (text === undefined) return { error: `token file ${source.path} could not be read` }
    const token = newestToken(text)
    return token === undefined
      ? { error: `token file ${source.path} does not contain a dsh launch token` }
      : { token }
  }
  const platform = deps.platform ?? process.platform
  if (source.kind === 'journal' && platform === 'win32') {
    return { error: 'the journal token source needs systemd (Linux); use "file" or "docker" on Windows' }
  }
  const run = deps.run ?? runFile
  const command = source.kind === 'journal' ? 'journalctl' : 'docker'
  const args = source.kind === 'journal'
    ? ['-u', source.unit, '-n', TOKEN_LOG_LINES, '--no-pager', '--output=cat']
    : ['logs', '--tail', TOKEN_LOG_LINES, source.container]
  const result = await run(command, args, TOKEN_COMMAND_TIMEOUT_MS)
  if (!result.ok) {
    const detail = result.error?.trim() === '' || result.error === undefined ? 'command failed' : result.error
    return { error: `could not read ${source.kind === 'journal' ? `journal for ${source.unit}` : `logs for container ${source.container}`}: ${detail}` }
  }
  const token = newestToken(result.stdout)
  return token === undefined
    ? { error: `${command} output does not contain a dsh launch token` }
    : { token }
}
