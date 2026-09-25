/**
 * git-specific reading: interpreting what git reports back.
 *
 * Running git is {@link module:proc}'s job; this module only knows the shapes
 * git answers in, so the parsers stay testable without a repository.
 *
 * @module git
 */

/** A local proxy a tool was told to use: the config key that named it and its host/port. */
export interface ProxySetting {
  /** The git config key, e.g. `http.proxy`. */
  key: string
  host: string
  port: number
}

/**
 * Parse the local-proxy entries out of `git config --get-regexp proxy` output.
 *
 * Only loopback targets are returned: a proxy pointing at this machine is one
 * the user runs and turns off (Clash and friends), so a dead one is a real
 * misconfiguration worth reporting. A remote proxy host may simply be
 * unreachable from where the user is right now, which is not ours to judge.
 */
export function parseLocalProxySettings(stdout: string): ProxySetting[] {
  const settings: ProxySetting[] = []
  for (const line of stdout.split(/\r?\n/)) {
    // `git config --get-regexp` prints "<key> <value>" (verified against git
    // 2.55 output: `http.proxy http://127.0.0.1:7897`).
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim())
    if (!m) continue
    const [, key, raw] = m
    // git's proxy keys all end in `.proxy` (http.proxy, https.proxy,
    // remote.<name>.proxy).
    if (!/\.proxy$/i.test(key)) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const port = Number(url.port)
    if (!isLoopback || !Number.isInteger(port) || port <= 0) continue
    settings.push({ key, host, port })
  }
  return settings
}
