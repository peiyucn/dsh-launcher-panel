/**
 * Making a source checkout runnable: dependencies, then the official-profile
 * build.
 *
 * A checkout is only usable once its deps are installed and its web client has
 * been built. Both can go stale in ways a single mtime check misses, so this
 * module asks dsh's *own* build record what it was built from instead of
 * tracking that in launcher-written files: the record already exists in every
 * official build, and a tag switch after a build shows up as a commit mismatch.
 *
 * @module server/checkout
 */

import * as vscode from 'vscode'
import {
  DSH_BUILD_PROFILE_OFFICIAL,
  DSH_BUILD_PROFILE_SELECTOR,
  checkoutDepsStale,
  checkoutHasOfficialBrand,
  checkoutReady,
  checkoutSupportsClean,
  checkoutSupportsOfficialBuild,
  clientBuildCommit,
} from '../paths.ts'
import { GIT_OP_TIMEOUT_MS } from '../timing.ts'
import { runFile } from '../proc.ts'

// The two filesystem predicates (checkoutReady / checkoutDepsStale) live in
// paths.ts: they are pure stat checks with no VS Code dependency, so keeping
// them here would make them untestable for no reason.
export { checkoutDepsStale, checkoutReady } from '../paths.ts'

/** What the checkout layer needs from the lifecycle it runs inside. */
export interface CheckoutHost {
  /** Report progress/failure into the panel feed; returns the entry id. */
  addActivity: (line: string, isBusy?: boolean) => number
  /** Run a long command in a visible terminal. */
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  /** Wrap a step so the panel shows the `installing` phase for its duration. */
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
  /** Whether the start flow is still active (a Stop may have intervened). */
  isStarting: () => boolean
}

/**
 * Whether the web client build predates the current HEAD: dsh's own official
 * build record carries the commit it was built from, so a tag switch / manual
 * checkout after the last build shows up as a mismatch. No launcher-written
 * files involved — the record already exists in every official build.
 */
export async function clientBuildStale(checkout: string): Promise<boolean> {
  const built = clientBuildCommit(checkout)
  if (built === undefined) return false
  const r = await runFile('git', ['-C', checkout, 'rev-parse', 'HEAD'], GIT_OP_TIMEOUT_MS)
  if (!r.ok) return false
  const head = r.stdout.trim()
  // 记录里可能是短哈希（7 位），HEAD 是完整哈希：前缀比较。
  return head !== '' && !head.startsWith(built)
}

/**
 * Make a checkout runnable: install its deps when missing/stale, then build
 * the web client with dsh's official profile so the UI shows the same
 * DeepSeek Harness brand as the packaged dsh. The build also re-runs when the
 * source moved past the last build (tag switch / checkout), detected via the
 * commit hash in dsh's own build record. A checkout this start just cloned
 * (`freshClone`) is set up automatically — the user already committed to the
 * install by starting it, so a second "setup?" prompt right after the clone
 * only slows them down.
 */
export async function ensureCheckoutReady(checkout: string, host: CheckoutHost, freshClone = false): Promise<boolean> {
  const staleDeps = checkoutDepsStale(checkout)
  const depsReady = checkoutReady(checkout) && !staleDeps
  // 官方构建记录里的 commit 与 HEAD 不同 = 源码在最后一次构建后变过（切 tag/切分支），
  // web 客户端和各包的产物过期。锁文件 mtime 看不到这种情况（两个 tag 锁文件相同时）。
  const supportsOfficial = checkoutSupportsOfficialBuild(checkout)
  const sourceChanged = supportsOfficial && await clientBuildStale(checkout)
  const needsBrandBuild = supportsOfficial && !checkoutHasOfficialBrand(checkout)
  const needsBuild = sourceChanged || needsBrandBuild
  if (!depsReady || needsBuild) {
    if (!freshClone) {
      const pick = await vscode.window.showInformationMessage(
        !depsReady
          ? (staleDeps
              ? 'This deepseek-harness checkout has outdated dependencies. Run `pnpm install` and `pnpm run build`?'
              : 'This deepseek-harness checkout is not set up. Run `pnpm install` and `pnpm run build`?')
          : 'This deepseek-harness checkout has changed since its last build. Rebuild (`pnpm run clean` + `pnpm run build`)?',
        'Setup now',
        'Cancel',
      )
      if (pick !== 'Setup now') {
        // The setup prompt was dismissed: say so in the console instead of
        // silently stopping after "Node.js detected".
        host.addActivity(!depsReady
          ? '✗ Setup declined — the checkout needs pnpm install + build before dsh can start'
          : '✗ Rebuild declined — the checkout build predates its source')
        return false
      }
    } else {
      host.addActivity('ℹ Fresh clone — running the one-time setup (pnpm install + build) automatically')
    }
    if (!depsReady) {
      // The phase is already 'starting' (set at the top of ensureRunningUnlocked),
      // so setup needs no extra flag handling — the panel spinner is driven by it.
      host.addActivity(`▶ Setup: pnpm --dir "${checkout}" install`)
      const installOk = await host.runInstalling(() => host.runInTerminal('Setup deepseek-harness (pnpm install)', 'pnpm', ['--dir', checkout, 'install', '--frozen-lockfile']))
      if (!installOk) {
        if (host.isStarting()) {
          host.addActivity('✗ pnpm install failed')
          void vscode.window.showErrorMessage('DeepSeek Harness: pnpm install failed. Check the terminal output.')
        }
        return false
      }
    }
  }
  // Build with the official profile whenever the current artifacts predate it
  // (brand missing) or predate the current source (commit mismatch). The build
  // record makes this idempotent: after a rebuild it matches HEAD again.
  if (!depsReady || needsBuild) {
    if (depsReady) {
      host.addActivity(needsBrandBuild
        ? 'ℹ Web UI lacks the official brand — rebuilding once so it matches the packaged dsh'
        : 'ℹ Source changed since the last build — rebuilding so the web UI matches the checkout')
    }
    // Clear stale build outputs first: after a git pull, packages removed
    // from the tree leave orphan lib/ dirs behind (git does not delete ignored
    // files), and tsdown still globs them — breaking the build with
    // MISSING_EXPORT errors. dsh's own clean script removes that residue, so
    // the build below always starts from a clean tree. Older checkouts without
    // the script keep the previous behaviour.
    if (checkoutSupportsClean(checkout)) {
      host.addActivity(`▶ Setup: pnpm --dir "${checkout}" run clean`)
      const cleanOk = await host.runInstalling(() => host.runInTerminal('Setup deepseek-harness (pnpm run clean)', 'pnpm', ['--dir', checkout, 'run', 'clean']))
      if (!cleanOk) {
        // Do not hard-block: the build still gets a chance and reports its own
        // errors, but keep the clean failure visible for diagnosis.
        host.addActivity('⚠ pnpm run clean failed — continuing to the build anyway')
      }
    }
    host.addActivity(`▶ Setup: pnpm --dir "${checkout}" run build (official brand)`)
    const buildOk = await host.runInstalling(() => host.runInTerminal(
      'Setup deepseek-harness (pnpm run build)',
      'pnpm',
      ['--dir', checkout, 'run', 'build'],
      { [DSH_BUILD_PROFILE_SELECTOR]: DSH_BUILD_PROFILE_OFFICIAL },
    ))
    if (!buildOk) {
      if (host.isStarting()) {
        host.addActivity('✗ pnpm run build failed')
        void vscode.window.showErrorMessage('DeepSeek Harness: pnpm run build failed. Check the terminal output.')
      }
      return false
    }
  }
  return checkoutReady(checkout)
}
