/**
 * Checking for and applying dsh updates.
 *
 * The two run modes answer "what is newer?" differently and that difference is
 * the whole design:
 *
 * - **pkg** asks the npm registry which version the channel points at.
 * - **source** asks git which official release tag is newest, and compares
 *   *commits* rather than fetching — the tag listing already carries the sha it
 *   resolves to, so containment is a local question.
 *
 * An update rewrites the tree the server runs from, so both entry and every
 * destructive boundary check that the server is still stopped: the `git fetch`
 * can take minutes on a checkout that is far behind, and a decision made before
 * it is not evidence about the world after it.
 *
 * @module server/update
 */

import { dshVersionAtLeast } from '../versions.ts'
import { newestReleaseTag } from '../versions.ts'
import { decideSourceUpdate, type UpdateCheckOutcome } from '../versions.ts'
import { GIT_FETCH_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'
import type { NpmChannel } from '../env.ts'
import { commitIsContained, explainGitFailure, listReleaseTags } from './release-tags.ts'
import { ensureDshInstalled, ensurePnpmAvailable, latestDshVersion, pkgInstallDir, pkgInstalledVersion } from './install.ts'
import type { InstallHost } from './install.ts'
import { ensureCheckoutReady, type CheckoutHost } from './checkout.ts'

/** The panel-facing result of one update check. */
export type DshUpdate = UpdateCheckOutcome

/** What the update layer needs from the lifecycle it runs inside. */
export interface UpdateHost {
  /** Resolved settings for this check/update. */
  readConfig: () => { runMode: 'pnpm' | 'source'; npmChannel: NpmChannel; srcPath: string; pkgPath: string }
  /** The source checkout to compare against, when there is one. */
  findSourceCheckout: () => string | undefined
  /** Report progress/failure into the panel feed; returns the entry id. */
  addActivity: (line: string, isBusy?: boolean) => number
  /**
   * Run `task` behind a spinner, clearing it whether the task succeeds or
   * throws. Preferred over pairing addActivity(…, true) with finishBusy: a
   * throw between the two leaves the spinner turning for the session.
   */
  withBusy: <T>(label: string, task: () => Promise<T>) => Promise<T>
  /** Run a long command in a visible terminal. */
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  /** Diagnostic line to the log file only. */
  dbg: (line: string) => void
  /** Whether the server is still stopped (an update may only run then). */
  isStopped: () => boolean
  /** Called after a successful update so the next refresh re-checks. */
  invalidateUpdateCache: () => void
  /** The install/checkout hosts the update reuses for its own steps. */
  installHost: InstallHost
  checkoutHost: CheckoutHost
}

/**
 * Whether an update may still rewrite the tree.
 *
 * The entry guard runs before the slow steps (a registry lookup, a `git fetch`
 * that scales with how far behind the checkout is), so every destructive
 * boundary re-checks the phase instead of trusting a decision made minutes
 * earlier. Start is refused while an update runs, but a Stop or any other path
 * that brought a server up still has to be honoured here.
 */
function mayProceed(host: UpdateHost): boolean {
  if (host.isStopped()) return true
  host.addActivity('↑ Update abandoned — dsh is no longer stopped')
  return false
}

/** Check for a newer dsh version: pkg compares the registry; source compares the newest official release tag. */
export async function checkDshUpdateStatus(host: UpdateHost): Promise<DshUpdate> {
  const cfg = host.readConfig()
  if (cfg.runMode === 'pnpm') {
    const installed = pkgInstalledVersion(cfg)
    if (!installed) return { hasUpdate: false, label: '' }
    const latest = await latestDshVersion(cfg.npmChannel, host.dbg)
    if ('error' in latest) {
      return { hasUpdate: false, label: '', failed: true, failedReason: latest.error }
    }
    if (latest.version !== installed && dshVersionAtLeast(latest.version, installed)) {
      return { hasUpdate: true, label: `v${latest.version}` }
    }
    return { hasUpdate: false, label: '' }
  }
  const checkout = host.findSourceCheckout()
  if (!checkout) return { hasUpdate: false, label: '' }
  // Compare by *commit*, not by fetching: the listing already carries the sha
  // the tag resolves to, so containment is a purely local question (is that
  // commit in HEAD?) that needs no network beyond the one listing.
  const listed = await listReleaseTags(checkout)
  if ('error' in listed) {
    return { hasUpdate: false, label: '', failed: true, failedReason: listed.error }
  }
  const newest = newestReleaseTag(listed.tags)
  // Contained means the checkout sits on that tag or is already past it (e.g.
  // master after the tag) — updating would move the checkout backwards.
  const contained = newest !== undefined && await commitIsContained(checkout, newest.commit)
  return decideSourceUpdate(newest, contained)
}

/** The in-flight update state, owned by this module. */
let updateInFlight = false

/** Current update state (the panel fallback reads it instead of assuming false). */
export function isUpdating(): boolean {
  return updateInFlight
}

/**
 * Update dsh: pkg reinstalls the latest published version; source checks out the
 * newest official release tag.
 */
export async function runDshUpdate(host: UpdateHost): Promise<void> {
  // No phase state covers an update, so guard it directly: coalesce repeat
  // clicks onto one run, and refuse to update while the server is up (a git
  // checkout / pnpm install under a running dsh can break it).
  if (updateInFlight) {
    host.addActivity('↑ Update already in progress')
    return
  }
  if (!host.isStopped()) {
    host.addActivity('↑ Stop dsh before updating')
    return
  }
  updateInFlight = true
  try {
    await runDshUpdateInner(host)
  } finally {
    updateInFlight = false
  }
}

async function runDshUpdateInner(host: UpdateHost): Promise<void> {
  const cfg = host.readConfig()
  if (cfg.runMode === 'pnpm') {
    const pnpm = await ensurePnpmAvailable(host.installHost)
    if (!pnpm) return
    const latest = await latestDshVersion(cfg.npmChannel, host.dbg, pnpm.command)
    if ('error' in latest) {
      host.addActivity(`↑ Update check failed (network) — ${latest.error}`)
      return
    }
    if (pkgInstalledVersion(cfg) === latest.version) {
      host.addActivity('↑ dsh is already up to date')
      return
    }
    host.addActivity(`↑ Updating dsh to v${latest.version}…`)
    if (!mayProceed(host)) return
    if (await ensureDshInstalled(latest.version, pnpm.command, pnpm.allowBuild, pkgInstallDir(cfg), host.installHost)) {
      host.addActivity('↑ dsh updated')
      host.invalidateUpdateCache()
    }
    return
  }
  const checkout = host.findSourceCheckout()
  if (!checkout) {
    host.addActivity('↑ No source checkout configured')
    return
  }
  // Source updates pin the newest official release tag (never upstream master
  // and never the npm channel — that only governs pkg installs).
  const listed = await listReleaseTags(checkout)
  if ('error' in listed) {
    host.addActivity(`↑ Update check failed (network) — ${listed.error}`)
    return
  }
  const newest = newestReleaseTag(listed.tags)
  if (newest === undefined) {
    host.addActivity('↑ Update check failed — origin lists no official dsh release tag')
    return
  }
  const tag = newest.tag
  const version = tag.slice('dsh-v'.length)
  if (await commitIsContained(checkout, newest.commit)) {
    host.addActivity('↑ dsh is already up to date')
    return
  }
  // The transfer below is the one operation whose size the launcher cannot
  // bound (it scales with how far behind the checkout is), so it gets the long
  // fetch timeout and its own progress note. Everything before it — the tag
  // listing and the containment probe — can take seconds too, so re-check here.
  if (!mayProceed(host)) return
  const fetchResult = await host.withBusy(
    `↑ Fetching ${tag} (this can take a while on a checkout that is far behind)…`,
    () => runFile('git', ['-C', checkout, 'fetch', 'origin', 'tag', tag], GIT_FETCH_TIMEOUT_MS),
  )
  if (!fetchResult.ok) {
    const cause = await explainGitFailure(checkout)
    host.addActivity(`↑ Update failed — ${cause ?? fetchResult.error ?? `could not fetch ${tag}`}`)
    return
  }
  // The fetch above can run for minutes: re-check before the checkout rewrites
  // the tree the (possibly now running) server would be reading from.
  if (!mayProceed(host)) return
  host.addActivity(`↑ Updating dsh to v${version}…`)
  const ok = await host.runInTerminal('Update DeepSeek Harness', 'git', ['-C', checkout, 'checkout', '--detach', tag])
  if (!ok) {
    host.addActivity('↑ dsh update failed')
    return
  }
  // A different tag usually carries a different lockfile: refresh the
  // checkout's setup so the next start runs the released tree.
  const ready = await ensureCheckoutReady(checkout, host.checkoutHost)
  host.addActivity(ready ? '↑ dsh updated' : '↑ dsh updated — the checkout setup still needs to finish before the next start')
  host.invalidateUpdateCache()
}
