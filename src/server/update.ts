import {
  decideSourceUpdate,
  dshVersionAtLeast,
  newestReleaseTag,
  type RemoteReleaseTag,
  type UpdateCheckOutcome,
} from '../versions.ts'
import { GIT_FETCH_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'
import type { NpmChannel } from '../env.ts'
import { commitIsContained, explainGitFailure, listReleaseTags, releaseVersion } from './release-tags.ts'
import { ensureDshInstalled, ensurePnpmAvailable, latestDshVersion, pkgInstallDir, pkgInstalledVersion } from './install.ts'
import type { InstallHost } from './install.ts'
import { ensureCheckoutReady, type CheckoutHost } from './checkout.ts'

export type DshUpdate = UpdateCheckOutcome

export interface UpdateHost {
  readConfig: () => { runMode: 'pnpm' | 'source'; npmChannel: NpmChannel; srcPath: string; pkgPath: string }
  findSourceCheckout: () => string | undefined
  addActivity: (line: string, isBusy?: boolean) => number
  withBusy: <T>(label: string, task: () => Promise<T>) => Promise<T>
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  dbg: (line: string) => void
  isStopped: () => boolean
  invalidateUpdateCache: () => void
  installHost: InstallHost
  checkoutHost: CheckoutHost
}

type SourceInspection =
  | { kind: 'release'; release: RemoteReleaseTag; contained: boolean }
  | { kind: 'failed'; reason: string }

// One probe for both callers: resolve the newest release and whether HEAD contains it.
async function inspectSource(checkout: string): Promise<SourceInspection> {
  const listed = await listReleaseTags(checkout)
  if ('error' in listed) return { kind: 'failed', reason: listed.error }
  const release = newestReleaseTag(listed.tags)
  if (release === undefined) return { kind: 'failed', reason: 'origin lists no official dsh release tag' }
  const containment = await commitIsContained(checkout, release.commit)
  if (containment === 'probe-failed') {
    // An unanswered probe is not "not contained": it must not offer a downgrade.
    const cause = await explainGitFailure(checkout)
    return { kind: 'failed', reason: cause ?? 'git could not compare the newest release tag with the checkout' }
  }
  return { kind: 'release', release, contained: containment === 'contained' }
}

function mayProceed(host: UpdateHost): boolean {
  if (host.isStopped()) return true
  host.addActivity('↑ Update abandoned — dsh is no longer stopped')
  return false
}

let updateInFlight = false

export function isUpdating(): boolean {
  return updateInFlight
}

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
  const inspected = await inspectSource(checkout)
  if (inspected.kind === 'failed') {
    return { hasUpdate: false, label: '', failed: true, failedReason: inspected.reason }
  }
  return decideSourceUpdate(inspected.release, inspected.contained)
}

export async function runDshUpdate(host: UpdateHost): Promise<void> {
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
    const cfg = host.readConfig()
    if (cfg.runMode === 'pnpm') {
      const pnpm = await ensurePnpmAvailable(host.installHost)
      if (!pnpm) {
        host.addActivity('↑ Update failed — pnpm is not available (see the messages above)')
        return
      }
      const latest = await latestDshVersion(cfg.npmChannel, host.dbg, pnpm.command)
      if ('error' in latest) {
        host.addActivity(latest.pnpmUnusable
          ? `↑ Update check failed — pnpm cannot be launched: ${latest.error}`
          : `↑ Update check failed (network) — ${latest.error}`)
        return
      }
      if (pkgInstalledVersion(cfg) === latest.version) {
        host.addActivity('↑ dsh is already up to date')
        return
      }
      host.addActivity(`↑ Updating dsh to v${latest.version}…`)
      if (!mayProceed(host)) return
      if (!(await ensureDshInstalled(latest.version, pnpm.command, pnpm.allowBuild, pkgInstallDir(cfg), host.installHost))) {
        host.addActivity('↑ Update failed — dsh was not updated (see the terminal output above)')
        return
      }
      host.addActivity(`↑ dsh updated to v${latest.version}`)
      host.invalidateUpdateCache()
      return
    }

    const checkout = host.findSourceCheckout()
    if (!checkout) {
      host.addActivity('↑ Update failed — no source checkout is configured')
      return
    }
    const inspected = await inspectSource(checkout)
    if (inspected.kind === 'failed') {
      host.addActivity(`↑ Update failed — ${inspected.reason}`)
      return
    }
    if (inspected.contained) {
      host.addActivity('↑ dsh is already up to date')
      return
    }
    const { tag } = inspected.release
    const version = releaseVersion(tag)
    // A far-behind fetch can take minutes; re-check Stop at every destructive boundary.
    if (!mayProceed(host)) return
    const fetched = await host.withBusy(
      `↑ Fetching ${tag} (this can take a while on a checkout that is far behind)…`,
      () => runFile('git', ['-C', checkout, 'fetch', 'origin', 'tag', tag], GIT_FETCH_TIMEOUT_MS),
    )
    if (!fetched.ok) {
      const cause = await explainGitFailure(checkout)
      host.addActivity(`↑ Update failed — ${cause ?? fetched.error ?? `could not fetch ${tag}`}`)
      return
    }
    if (!mayProceed(host)) return
    host.addActivity(`↑ Updating dsh to v${version}…`)
    if (!(await host.runInTerminal('Update DeepSeek Harness', 'git', ['-C', checkout, 'checkout', '--detach', tag]))) {
      host.addActivity(`↑ Update failed — git checkout ${tag} did not finish (see the terminal output above)`)
      return
    }
    // A different tag usually carries a different lockfile; refresh the checkout.
    if (await ensureCheckoutReady(checkout, host.checkoutHost)) {
      host.addActivity(`↑ dsh updated to v${version}`)
    } else {
      host.addActivity(`⚠ dsh is now on v${version}, but its checkout setup did not finish — run Start again to finish pnpm install + build`)
    }
    host.invalidateUpdateCache()
  } finally {
    updateInFlight = false
  }
}
