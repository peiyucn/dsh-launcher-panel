import { GIT_OP_TIMEOUT_MS, GIT_REMOTE_TIMEOUT_MS, PORT_PROBE_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'
import { parseLocalProxySettings } from '../git.ts'
import { parseRemoteReleaseTags, type RemoteReleaseTag } from '../versions.ts'
import { isPortOpen } from './probes.ts'

const RELEASE_TAG_PREFIX = 'dsh-v'

type CommitContainment = 'contained' | 'not-contained' | 'probe-failed'

export function classifyContainment(result: { ok: boolean; code?: number }): CommitContainment {
  if (result.ok) return 'contained'
  // 128: the tag object is unknown locally because it was never fetched.
  if (result.code === 1 || result.code === 128) return 'not-contained'
  // No exit code means the command never ran to completion: a probe failure, not an answer.
  return 'probe-failed'
}

export function releaseVersion(tagName: string): string {
  return tagName.startsWith(RELEASE_TAG_PREFIX) ? tagName.slice(RELEASE_TAG_PREFIX.length) : tagName
}

export async function explainGitFailure(checkout: string): Promise<string | undefined> {
  // -C scopes the lookup to the checkout; git config would otherwise read the host's cwd.
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

export async function commitIsContained(checkout: string, commit: string): Promise<CommitContainment> {
  const r = await runFile('git', ['-C', checkout, 'merge-base', '--is-ancestor', commit, 'HEAD'], GIT_OP_TIMEOUT_MS)
  return classifyContainment(r)
}
