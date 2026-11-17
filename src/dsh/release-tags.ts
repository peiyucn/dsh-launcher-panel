import { GIT_OP_TIMEOUT_MS, GIT_REMOTE_TIMEOUT_MS, PORT_PROBE_TIMEOUT_MS } from '../shared/timing.ts'
import { runFile } from '../shared/proc.ts'
import { parseLocalProxySettings } from './git.ts'
import { parseLocalReleaseTags, parseRemoteReleaseTags, type RemoteReleaseTag } from './versions.ts'
import { isPortOpen } from './probes.ts'

const RELEASE_TAG_PREFIX = 'dsh-v'

export function releaseVersion(tagName: string): string {
  return tagName.startsWith(RELEASE_TAG_PREFIX) ? tagName.slice(RELEASE_TAG_PREFIX.length) : tagName
}

export async function explainGitFailure(checkout: string): Promise<string | undefined> {
  const r = await runFile('git', ['-C', checkout, 'config', '--get-regexp', 'proxy'], GIT_OP_TIMEOUT_MS)
  if (r.stdout.trim() === '') return undefined
  for (const setting of parseLocalProxySettings(r.stdout)) {
    if (await isPortOpen(setting.host, setting.port, PORT_PROBE_TIMEOUT_MS)) continue
    return `git is configured to use the proxy ${setting.host}:${setting.port} (${setting.key}), but nothing is listening there — start your proxy app or remove that git setting`
  }
  return undefined
}

export async function listReleaseTags(checkout: string): Promise<{ tags: RemoteReleaseTag[] } | { error: string }> {
  const r = await runFile('git', ['-C', checkout, 'ls-remote', '--tags', 'origin'], GIT_REMOTE_TIMEOUT_MS)
  if (!r.ok) {
    const cause = await explainGitFailure(checkout)
    return { error: cause ?? r.error ?? 'could not list the official release tags' }
  }
  return { tags: parseRemoteReleaseTags(r.stdout) }
}

export async function headCommit(checkout: string): Promise<string | undefined> {
  const r = await runFile('git', ['-C', checkout, 'rev-parse', 'HEAD'], GIT_OP_TIMEOUT_MS)
  return r.ok ? r.stdout.trim() || undefined : undefined
}

export async function commitOfTag(checkout: string, tag: string): Promise<string | undefined> {
  const r = await runFile('git', ['-C', checkout, 'rev-parse', `${tag}^{commit}`], GIT_OP_TIMEOUT_MS)
  return r.ok ? r.stdout.trim() || undefined : undefined
}

export async function listLocalReleaseTags(checkout: string): Promise<{ tags: string[] } | { error: string }> {
  const r = await runFile('git', ['-C', checkout, 'tag', '--list', 'dsh-v*'], GIT_OP_TIMEOUT_MS)
  if (!r.ok) return { error: r.error ?? 'could not list the local release tags' }
  return { tags: parseLocalReleaseTags(r.stdout) }
}

export async function pinCheckoutToTag(checkout: string, tag: string): Promise<boolean> {
  const r = await runFile('git', ['-C', checkout, 'checkout', '--detach', tag], GIT_OP_TIMEOUT_MS)
  return r.ok
}
