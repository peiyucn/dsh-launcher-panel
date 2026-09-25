/**
 * dsh version strings: comparing them, reading them out of git, and turning a
 * release listing into the panel's update verdict.
 *
 * Everything here is pure — no process spawning, no filesystem — so the version
 * rules that decide whether the panel offers an Update button can be tested
 * directly.
 *
 * @module versions
 */

/** dsh ≥ this version opens the system browser on its own; the launcher then passes `--no-open`. */
export const DSH_NO_OPEN_MIN_VERSION = '0.1.0-rc.8'

/**
 * dsh ≥ this version boots its CLI behind an `import.meta.main` guard (its
 * entry point only runs when that binding is true). The binding exists in Node
 * ≥ 22.18 / ≥ 24.2 only, while dsh's engines still advertise `^22.19 || >=24`
 * — on Node 24.0/24.1 the guarded entry never runs and dsh exits silently with
 * no output at all.
 */
export const DSH_CLI_ENTRY_GUARD_MIN_VERSION = '0.1.3-alpha.2'

/** Order two dsh versions: -1 (a older), 0 (equal), 1 (a newer). Prereleases: alpha < beta < rc < stable. */
export function compareDshVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: { kind: string; n: number } | null } | undefined => {
    const m = /^(\d+(?:\.\d+)*)(?:-([a-z]+)(?:\.(\d+))?)?$/.exec(v)
    if (!m) return undefined
    return {
      core: m[1].split('.').map(Number),
      pre: m[2] === undefined ? null : { kind: m[2], n: m[3] === undefined ? 0 : Number(m[3]) },
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === undefined || pb === undefined) return a === b ? 0 : (a > b ? 1 : -1)
  const len = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < len; i++) {
    const x = pa.core[i] ?? 0
    const y = pb.core[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  // 0.1.2（正式）> 0.1.2-rc.1 > 0.1.2-alpha.5
  if (pa.pre === null) return pb.pre === null ? 0 : 1
  if (pb.pre === null) return -1
  const rank = (k: string): number => (k === 'alpha' ? 0 : k === 'beta' ? 1 : k === 'rc' ? 2 : 3)
  if (pa.pre.kind !== pb.pre.kind) return rank(pa.pre.kind) > rank(pb.pre.kind) ? 1 : -1
  return pa.pre.n === pb.pre.n ? 0 : (pa.pre.n > pb.pre.n ? 1 : -1)
}

/** Pick the newest version from a list of dsh version strings. */
export function newestDshVersion(versions: string[]): string | undefined {
  let best: string | undefined
  for (const v of versions) {
    if (best === undefined || compareDshVersions(v, best) > 0) best = v
  }
  return best
}

/**
 * Whether `version` is at least `target`. Ordering is delegated to
 * {@link compareDshVersions} so a stable release outranks its own prereleases
 * ('0.1.5' > '0.1.5-rc.1') — comparing '0.1.5' with '0.1.5-rc.1' segment by
 * segment treated the shorter (stable) version as missing a segment and thus
 * as *older*, which silently hid every stable release after an rc.
 */
export function dshVersionAtLeast(version: string, target: string): boolean {
  return compareDshVersions(version, target) >= 0
}

/** 从 git describe 输出提取基准版本（'dsh-v0.1.2-rc.1-99-g76fda72' → '0.1.2-rc.1'）；`dsh-v` / `v` / 裸版本号三种写法都认。 */
export function versionFromDescribe(describe: string): string | undefined {
  const m = /^(?:dsh-)?v?(\d[^\s]*?)(?:-\d+-g[0-9a-f]+)?$/.exec(describe.trim())
  return m?.[1]
}

/**
 * 把 source 模式的 `git describe` 输出规整成 pkg 模式同一种**裸版本号**（都带 `v`
 * 会与面板补的前缀叠成 `vv…`）：只去掉官方 tag 的 `dsh-v` 前缀
 * （'dsh-v0.1.2-rc.1' → '0.1.2-rc.1'），不在 tag 上时的 `-N-gsha` 后缀原样保留。
 * git 命令参数用不到它（tag 名只在内部流转），面板显示与 {versionFromDescribe} 都
 * 直接消费规整后的值。
 */
export function dshVersionFromDescribe(describe: string): string {
  return describe.trim().replace(/^dsh-v/, '')
}

/** An official release tag on origin: its tag name and the commit it points at. */
export interface RemoteReleaseTag {
  /** Full tag name, e.g. `dsh-v0.1.7-alpha.1`. */
  tag: string
  /** Commit the tag resolves to (the peeled commit for an annotated tag). */
  commit: string
}

/**
 * Parse `git ls-remote --tags origin` output into the official release tags.
 *
 * Only `dsh-v<semver>` names are kept — other tags in the upstream repo are not
 * dsh releases. An annotated tag lists twice (the plain ref points at the tag
 * object, the `^{}` line at the commit); the peeled commit is the one worth
 * comparing against a checkout, so it wins regardless of line order.
 */
export function parseRemoteReleaseTags(stdout: string): RemoteReleaseTag[] {
  const commits = new Map<string, string>()
  const peeled = new Set<string>()
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^([0-9a-f]{7,40})\s+refs\/tags\/dsh-v([0-9][^\s^]*?)(\^\{\})?$/.exec(raw.trim())
    if (!m) continue
    const [, sha, version, isPeeled] = m
    if (!/^\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?$/.test(version)) continue
    if (isPeeled === '^{}') {
      commits.set(version, sha)
      peeled.add(version)
    } else if (!peeled.has(version)) {
      commits.set(version, sha)
    }
  }
  return [...commits].map(([version, commit]) => ({ tag: `dsh-v${version}`, commit }))
}

/** The newest official release among {@link parseRemoteReleaseTags} results. */
export function newestReleaseTag(tags: RemoteReleaseTag[]): RemoteReleaseTag | undefined {
  const newest = newestDshVersion(tags.map(entry => entry.tag.slice('dsh-v'.length)))
  return newest === undefined ? undefined : tags.find(entry => entry.tag === `dsh-v${newest}`)
}

/** The panel-facing result of one update check. */
export interface UpdateCheckOutcome {
  hasUpdate: boolean
  label: string
  /** True when the check could not answer (network etc.) — not "no update". */
  failed?: boolean
  /** Why the check failed (one line), shown after "Update check failed —". */
  failedReason?: string
}

/**
 * Decide the source-mode verdict from the newest listed release tag and whether
 * that tag's commit is already contained in the checkout.
 *
 * An empty listing is a *failed* check, never "up to date": `git ls-remote` can
 * succeed while every tag it returned is a shape this build does not recognize
 * (a SHA-256 origin, an unexpected prerelease spelling, an origin that carries
 * no `dsh-v*` tag at all), and reporting that as "up to date" would pin the
 * panel to a silent lie forever — the outcome {@link describeDshUpdate} forbids.
 */
export function decideSourceUpdate(newest: RemoteReleaseTag | undefined, contained: boolean): UpdateCheckOutcome {
  if (newest === undefined) {
    return { hasUpdate: false, label: '', failed: true, failedReason: 'origin lists no official dsh release tag' }
  }
  if (contained) return { hasUpdate: false, label: '' }
  return { hasUpdate: true, label: `v${newest.tag.slice('dsh-v'.length)}` }
}

/**
 * One-line summary of the last dsh update check for the panel console. A
 * failed check must never read as "up to date" — it is reported as failed, with
 * the underlying reason when one was captured (`failedReason`), because
 * "Update check failed" alone left a network outage, a timeout, and a broken
 * git install indistinguishable.
 */
export function describeDshUpdate(update: { hasUpdate: boolean; label: string; failed?: boolean; failedReason?: string } | undefined): string {
  if (update?.failed) return update.failedReason ? `⚠ Update check failed — ${update.failedReason}` : '⚠ Update check failed'
  if (update?.hasUpdate) return `✓ Update available → ${update.label}`
  return '✓ dsh is up to date'
}
