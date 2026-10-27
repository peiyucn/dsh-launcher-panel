// From this version dsh opens the system browser itself, so the launcher passes --no-open.
export const DSH_NO_OPEN_MIN_VERSION = '0.1.0-rc.8'

// Orders `x.y.z[-kind[.n]]` shapes; anything else falls back to plain string order.
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
  if (pa.pre === null) return pb.pre === null ? 0 : 1
  if (pb.pre === null) return -1
  const rank = (k: string): number => (k === 'alpha' ? 0 : k === 'beta' ? 1 : k === 'rc' ? 2 : 3)
  if (pa.pre.kind !== pb.pre.kind) return rank(pa.pre.kind) > rank(pb.pre.kind) ? 1 : -1
  return pa.pre.n === pb.pre.n ? 0 : (pa.pre.n > pb.pre.n ? 1 : -1)
}

export function newestDshVersion(versions: string[]): string | undefined {
  let best: string | undefined
  for (const v of versions) {
    if (best === undefined || compareDshVersions(v, best) > 0) best = v
  }
  return best
}

export function dshVersionAtLeast(version: string, target: string): boolean {
  return compareDshVersions(version, target) >= 0
}

// Tags may be dsh-v…, v… or bare semver; git describe adds -N-gsha off the tag.
export function versionFromDescribe(describe: string): string | undefined {
  const m = /^(?:dsh-)?v?(\d[^\s]*?)(?:-\d+-g[0-9a-f]+)?$/.exec(describe.trim())
  return m?.[1]
}

// Strips the official tag prefix only: callers prepend their own `v`, and the -N-gsha suffix is kept for display.
export function dshVersionFromDescribe(describe: string): string {
  return describe.trim().replace(/^dsh-v/, '')
}

export interface RemoteReleaseTag {
  tag: string
  commit: string
}

// Only dsh-v tags are releases; the peeled ^{} commit wins for annotated tags.
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

export function newestReleaseTag(tags: RemoteReleaseTag[]): RemoteReleaseTag | undefined {
  const newest = newestDshVersion(tags.map(entry => entry.tag.slice('dsh-v'.length)))
  return newest === undefined ? undefined : tags.find(entry => entry.tag === `dsh-v${newest}`)
}

export interface UpdateCheckOutcome {
  hasUpdate: boolean
  label: string
  failed?: boolean
  failedReason?: string
}

// An unrecognized listing is a failed check, never "up to date".
export function decideSourceUpdate(newest: RemoteReleaseTag | undefined, contained: boolean): UpdateCheckOutcome {
  if (newest === undefined) {
    return { hasUpdate: false, label: '', failed: true, failedReason: 'origin lists no official dsh release tag' }
  }
  if (contained) return { hasUpdate: false, label: '' }
  return { hasUpdate: true, label: `v${newest.tag.slice('dsh-v'.length)}` }
}

// A failed check must never render as up to date, and the reason is what tells outages apart.
export function describeDshUpdate(update: { hasUpdate: boolean; label: string; failed?: boolean; failedReason?: string } | undefined): string {
  if (update?.failed) return update.failedReason ? `⚠ Update check failed — ${update.failedReason}` : '⚠ Update check failed'
  if (update?.hasUpdate) return `✓ Update available → ${update.label}`
  return '✓ dsh is up to date'
}
