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
import { reportStepFailure } from './terminal.ts'

export interface CheckoutHost {
  addActivity: (line: string, isBusy?: boolean) => number
  runInTerminal: (title: string, command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  runInstalling: <T>(task: () => Promise<T>) => Promise<T>
}

async function clientBuildStale(checkout: string): Promise<boolean> {
  const built = clientBuildCommit(checkout)
  if (built === undefined) return false
  const r = await runFile('git', ['-C', checkout, 'rev-parse', 'HEAD'], GIT_OP_TIMEOUT_MS)
  if (!r.ok) return false
  const head = r.stdout.trim()
  // The build record may hold a short hash; HEAD is the full one.
  return head !== '' && !head.startsWith(built)
}

export async function ensureCheckoutReady(checkout: string, host: CheckoutHost, freshClone = false): Promise<boolean> {
  const staleDeps = checkoutDepsStale(checkout)
  const depsReady = checkoutReady(checkout) && !staleDeps
  const supportsOfficial = checkoutSupportsOfficialBuild(checkout)
  const needsBrand = supportsOfficial && !checkoutHasOfficialBrand(checkout)
  // Lockfile mtimes cannot see a tag switch; dsh's own build record can.
  const sourceChanged = supportsOfficial && await clientBuildStale(checkout)
  if (depsReady && !needsBrand && !sourceChanged) return true

  if (freshClone) {
    host.addActivity('ℹ Fresh clone — running the one-time setup (pnpm install + build) automatically')
  } else {
    const question = !depsReady
      ? (staleDeps
        ? 'This deepseek-harness checkout has outdated dependencies. Run `pnpm install` and `pnpm run build`?'
        : 'This deepseek-harness checkout is not set up. Run `pnpm install` and `pnpm run build`?')
      : 'This deepseek-harness checkout has changed since its last build. Rebuild (`pnpm run clean` + `pnpm run build`)?'
    if (await vscode.window.showInformationMessage(question, 'Setup now', 'Cancel') !== 'Setup now') {
      host.addActivity(!depsReady
        ? '✗ Setup declined — the checkout needs pnpm install + build before dsh can start'
        : '✗ Rebuild declined — the checkout build predates its source')
      return false
    }
  }

  const setup = (title: string, args: string[], env?: Record<string, string>): Promise<boolean> =>
    host.runInstalling(() => host.runInTerminal(title, 'pnpm', ['--dir', checkout, ...args], env))

  if (!depsReady) {
    host.addActivity(`▶ Setup: pnpm --dir "${checkout}" install`)
    if (!(await setup('Setup deepseek-harness (pnpm install)', ['install', '--frozen-lockfile']))) {
      reportStepFailure(host, '✗ pnpm install failed', 'DeepSeek Harness: pnpm install failed. Check the terminal output.')
      return false
    }
  } else {
    host.addActivity(needsBrand
      ? 'ℹ Web UI lacks the official brand — rebuilding once so it matches the packaged dsh'
      : 'ℹ Source changed since the last build — rebuilding so the web UI matches the checkout')
  }

  // Leftover lib/ dirs from packages removed in a git pull break tsdown; dsh's
  // own clean script is the only reliable reset.
  if (checkoutSupportsClean(checkout)) {
    host.addActivity(`▶ Setup: pnpm --dir "${checkout}" run clean`)
    if (!(await setup('Setup deepseek-harness (pnpm run clean)', ['run', 'clean']))) {
      host.addActivity('⚠ pnpm run clean failed — continuing to the build anyway')
    }
  }
  host.addActivity(`▶ Setup: pnpm --dir "${checkout}" run build (official brand)`)
  const buildOk = await setup(
    'Setup deepseek-harness (pnpm run build)',
    ['run', 'build'],
    { [DSH_BUILD_PROFILE_SELECTOR]: DSH_BUILD_PROFILE_OFFICIAL },
  )
  if (!buildOk) {
    reportStepFailure(host, '✗ pnpm run build failed', 'DeepSeek Harness: pnpm run build failed. Check the terminal output.')
    return false
  }
  return checkoutReady(checkout)
}
