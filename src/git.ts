interface ProxySetting {
  key: string
  host: string
  port: number
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Only loopback proxies are reported: a remote proxy being unreachable from here is not ours to judge.
export function parseLocalProxySettings(stdout: string): ProxySetting[] {
  const settings: ProxySetting[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim())
    if (!m) continue
    const [, key, raw] = m
    if (!/\.proxy$/i.test(key)) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port)
    if (!LOOPBACK_HOSTS.has(host) || !Number.isInteger(port) || port <= 0) continue
    settings.push({ key, host, port })
  }
  return settings
}
