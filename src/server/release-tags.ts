/**
 * Reading official dsh releases out of a source checkout's origin.
 *
 * The launcher tracks releases by *tag*, never by branch: source mode pins the
 * newest official `dsh-v<version>` tag and compares commits, so a checkout far
 * behind can be checked without transferring any history.
 *
 * Every failure here is turned into a one-line reason for the panel rather than
 * a thrown error — the caller's job is to show it, not to catch it.
 *
 * @module server/release-tags
 */

import { GIT_OP_TIMEOUT_MS, GIT_REMOTE_TIMEOUT_MS, PORT_PROBE_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'
import { parseLocalProxySettings } from '../git.ts'
import { parseRemoteReleaseTags, type RemoteReleaseTag } from '../versions.ts'
import { isPortOpen } from './probes.ts'

/**
 * A git command failed. When git is configured to use a local proxy whose port
 * nothing is listening on (a VPN/proxy app that was switched off), every
 * network operation fails with a generic error and the user is left guessing
 * at "npm is down". Say which proxy is dead instead — that is the actual fault.
 *
 * The lookup is scoped to `checkout` with `-C`: `git config` otherwise resolves
 * against the extension host's cwd, so it would read some unrelated repository's
 * local config — naming a proxy that has nothing to do with the command that
 * failed, while missing one configured in the checkout itself.
 *
 * @param checkout - the checkout the failed git command ran against.
 * @returns a one-line explanation, or undefined when no stale proxy explains it.
 */
export async function explainGitFailure(checkout: string): Promise<string | undefined> {
  const r = await runFile('git', ['-C', checkout, 'config', '--get-regexp', 'proxy'], GIT_OP_TIMEOUT_MS)
  // Exit 1 with no output simply means no proxy is configured.
  if (r.stdout.trim() === '') return undefined
  for (const setting of parseLocalProxySettings(r.stdout)) {
    if (await isPortOpen(setting.host, setting.port, PORT_PROBE_TIMEOUT_MS)) continue
    return `git is configured to use the proxy ${setting.host}:${setting.port} (${setting.key}), but nothing is listening there — start your proxy app or remove that git setting`
  }
  return undefined
}

/**
 * List the official release tags on origin (`dsh-vX.Y.Z[-pre]`) with the commits
 * they point at.
 *
 * This is a ref listing only: it transfers no history, so it stays fast no
 * matter how far behind the checkout is. Fetching the target tag is the Update
 * button's job, not the check's.
 */
export async function listReleaseTags(checkout: string): Promise<{ tags: RemoteReleaseTag[] } | { error: string }> {
  const r = await runFile('git', ['-C', checkout, 'ls-remote', '--tags', 'origin'], GIT_REMOTE_TIMEOUT_MS)
  if (!r.ok) {
    const cause = await explainGitFailure(checkout)
    return { error: cause ?? r.error ?? 'could not list the official release tags' }
  }
  return { tags: parseRemoteReleaseTags(r.stdout) }
}

/** Whether `commit` is already contained in the checkout's HEAD (on it, or past it). */
export async function commitIsContained(checkout: string, commit: string): Promise<boolean> {
  // `--is-ancestor` exits 0 for an ancestor *or* the commit itself, and 1 for a
  // commit HEAD does not contain. An unknown object exits 128 — treated as "not
  // contained", which is the same answer the user needs: update available.
  const r = await runFile('git', ['-C', checkout, 'merge-base', '--is-ancestor', commit, 'HEAD'], GIT_OP_TIMEOUT_MS)
  return r.ok
}
