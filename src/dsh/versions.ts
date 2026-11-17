export const DSH_NO_OPEN_MIN_VERSION = '0.1.0-rc.8'

export const DSH_NODE_24_9_FLOOR = '0.2.2-alpha.1'
export const DSH_NODE_24_9_MIN_VERSION = '24.9.0'

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

export function versionFromDescribe(describe: string): string | undefined {
  const m = /^(?:dsh-)?v?(\d[^\s]*?)(?:-\d+-g[0-9a-f]+)?$/.exec(describe.trim())
  return m?.[1]
}

export function dshVersionFromDescribe(describe: string): string {
  return describe.trim().replace(/^dsh-v/, '')
}

export function parseLocalReleaseTags(stdout: string): string[] {
  const tags: string[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const tag = raw.trim()
    if (!tag.startsWith('dsh-v')) continue
    if (!/^\d+\.\d+\.\d+(?:-[a-z]+(?:\.\d+)?)?$/.test(tag.slice('dsh-v'.length))) continue
    tags.push(tag)
  }
  return tags
}

export function newestLocalReleaseTag(tags: string[]): string | undefined {
  let best: string | undefined
  for (const tag of tags) {
    const version = tag.slice('dsh-v'.length)
    if (best === undefined || compareDshVersions(version, best.slice('dsh-v'.length)) > 0) best = tag
  }
  return best
}

export function nodeTooOldForDsh(dshVersion: string, nodeVersion: string): boolean {
  if (dshVersion === '' || nodeVersion === '') return false
  return dshVersionAtLeast(dshVersion, DSH_NODE_24_9_FLOOR)
    && !dshVersionAtLeast(nodeVersion, DSH_NODE_24_9_MIN_VERSION)
}

export interface RemoteReleaseTag {
  tag: string
  commit: string
}

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

export function decideSourceUpdate(newest: RemoteReleaseTag | undefined, atRelease: boolean): UpdateCheckOutcome {
  if (newest === undefined) {
    return { hasUpdate: false, label: '', failed: true, failedReason: 'origin lists no official dsh release tag' }
  }
  if (atRelease) return { hasUpdate: false, label: '' }
  return { hasUpdate: true, label: `v${newest.tag.slice('dsh-v'.length)}` }
}

export function describeDshUpdate(update: { hasUpdate: boolean; label: string; failed?: boolean; failedReason?: string } | undefined): string {
  if (update?.failed) return update.failedReason ? `⚠ Update check failed — ${update.failedReason}` : '⚠ Update check failed'
  if (update?.hasUpdate) return `✓ Update available → ${update.label}`
  return '✓ dsh is up to date'
}
