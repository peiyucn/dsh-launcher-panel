import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveDshHome, toEnglish } from './common'

/** One DeepSeek API service component on the official status page. */
export interface DsComponentStatus {
  name: string
  status: 'operational' | 'degraded' | 'partial_outage' | 'full_outage' | 'maintenance'
}

export interface DsIncident {
  title: string
  status: string
}

export interface DsStatus {
  state: 'ok' | 'degraded' | 'down' | 'maintenance' | 'unknown'
  components: DsComponentStatus[]
  incidents: DsIncident[]
}

export interface DshBalance {
  currency: string
  total: string
}

const DS_STATUS_PAGE_ID = 6410630422455
const DS_STATUS_PATH = `/api/status-page/${DS_STATUS_PAGE_ID}/summary/active`
// status.deepseek.com CNAMEs to statuspage.flashcat.cloud (same backend). The custom
// domain's TLS listener rejects some client stacks (e.g. Windows schannel), so use the
// backend host first and the custom domain as fallback.
const DS_STATUS_HOSTS = [
  'https://statuspage.flashcat.cloud',
  'https://status.deepseek.com',
]

/** Severity ordering (higher is worse). */
const DS_SEVERITY: Record<string, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  full_outage: 4,
}

const DS_STATUS_CACHE_TTL_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
const BALANCE_FETCH_TIMEOUT_MS = 10_000

let dsStatusCache: { status: DsStatus; at: number } | undefined
let balanceCache: { balance: DshBalance | null; error?: string; at: number } | undefined

async function fetchJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', ...headers } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

export async function getDsStatus(): Promise<DsStatus> {
  const now = Date.now()
  if (dsStatusCache && now - dsStatusCache.at < DS_STATUS_CACHE_TTL_MS) return dsStatusCache.status
  const result = await fetchDsStatus()
  dsStatusCache = { status: result, at: now }
  return result
}

async function fetchDsStatus(): Promise<DsStatus> {
  for (const host of DS_STATUS_HOSTS) {
    const url = `${host}${DS_STATUS_PATH}`
    try {
      const json = await fetchJson(url, FETCH_TIMEOUT_MS)
      return parseDsStatus(json)
    } catch {
      // try the next host
    }
  }
  return { state: 'unknown', components: [], incidents: [] }
}

export function parseDsStatus(json: any): DsStatus {
  try {
    const page = json?.data?.page ?? {}

    const statusById = new Map<string, string>()
    const raw: Array<{ id: string; name: string; order: number }> = []
    for (const c of page.components ?? []) {
      const id = String(c?.component_id ?? '')
      const rawName = toEnglish(String(c?.name ?? '')).toLowerCase()
      // Only API services are monitored (skip Chat Service modes).
      if (!id || !/api/i.test(rawName)) continue
      // Show just the model name: strip the trailing " api" suffix.
      const name = rawName.replace(/^deepseek\s+(v\d+)\s+(\S+)\s+api$/, 'deepseek-$1-$2').replace(/\s+api$/, '')
      statusById.set(id, 'operational')
      raw.push({ id, name, order: Number(c?.order_id ?? 0) || 0 })
    }
    raw.sort((a, b) => a.order - b.order)

    const incidents: DsIncident[] = []
    for (const ch of json?.data?.active_changes ?? []) {
      const affectsApi = (ch?.affected_components ?? []).some((ac: any) => /api/i.test(toEnglish(String(ac?.name ?? ''))))
      if (!affectsApi) continue
      incidents.push({
        title: toEnglish(String(ch?.title ?? '')),
        status: String(ch?.status ?? '').trim(),
      })
      for (const ac of ch?.affected_components ?? []) {
        const id = String(ac?.component_id ?? '')
        const st = String(ac?.status ?? '').trim()
        if (id && DS_SEVERITY[st] !== undefined) statusById.set(id, st)
      }
    }

    const components: DsComponentStatus[] = raw.map((c) => ({
      name: c.name,
      status: (statusById.get(c.id) ?? 'operational') as DsComponentStatus['status'],
    }))

    let worst = 'operational'
    for (const c of components) {
      if ((DS_SEVERITY[c.status] ?? 0) > (DS_SEVERITY[worst] ?? 0)) worst = c.status
    }

    const state: DsStatus['state'] =
      worst === 'full_outage' || worst === 'partial_outage' ? 'down'
      : worst === 'degraded' ? 'degraded'
      : worst === 'maintenance' ? 'maintenance'
      : 'ok'

    return {
      state,
      components,
      incidents,
    }
  } catch {
    return { state: 'unknown', components: [], incidents: [] }
  }
}

/** Read a credential from a flat name:value / name=value mapping (block or flow style). */
export function readCredentialFromFile(name: string, file: string): string | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    // Drop whole-line comments: a commented-out key must not count as set.
    const text = raw.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n')
    // Whole-file scan: matches KEY: value / KEY= value in both block style
    // (one per line) and flow style ({ KEY: value }, which dsh writes), with
    // quoted or bare values. Values must sit on the key's own line: whitespace
    // around the separator is [ \t] only, so a valueless parent key (dsh's
    // credentials.yaml writes `refs:` / `records:` blocks) can never swallow
    // the next line's key as its value.
    const re = /(?:^|[{\s,])([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[:=][ \t]*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[1] !== name) continue
      const value = m[2] ?? m[3] ?? m[4]
      if (value !== undefined) return value
    }
  } catch {
    // no such file
  }
  return undefined
}

/**
 * Resolve a credential exactly where dsh does: the inherited environment
 * wins, then `$DSH_HOME/.credentials.yaml` (the Models-page store), then the
 * invoking directory's `.env`, then `$DSH_HOME/.env`.
 */
function readCredential(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  return readCredentialFromFile(name, path.join(resolveDshHome(), '.credentials.yaml'))
    ?? readCredentialFromFile(name, path.join(process.cwd(), '.env'))
    ?? readCredentialFromFile(name, path.join(resolveDshHome(), '.env'))
}

/** Read the default Agent model selection from settings.yaml. */
export function readDefaultModel(): { provider: string; model: string } | undefined {
  try {
    const lines = fs.readFileSync(path.join(resolveDshHome(), 'settings.yaml'), 'utf8').split(/\r?\n/)
    let section = ''
    let provider = ''
    let model = ''
    for (const line of lines) {
      const m = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
      if (!m) continue
      if (m[1] === '') {
        section = m[2]
      } else if (section === 'agent-default-model') {
        if (m[2] === 'provider') provider = m[3].trim()
        else if (m[2] === 'model') model = m[3].trim()
      }
    }
    if (provider || model) return { provider, model }
  } catch {
    // no settings file
  }
  return undefined
}

/**
 * Whether DeepSeek is configured: the default Agent model uses a DeepSeek
 * provider/model, or a DeepSeek API key is present. The panel shows the
 * DeepSeek API status card only when this is true.
 */
export function hasDeepSeekModel(): boolean {
  if (readCredential('DEEPSEEK_API_KEY')) return true
  const sel = readDefaultModel()
  return sel !== undefined && /deepseek/i.test(`${sel.provider} ${sel.model}`)
}

/** Query the DeepSeek account balance using the key configured in dsh. */
export async function fetchDshBalance(): Promise<void> {
  const key = readCredential('DEEPSEEK_API_KEY')
  if (!key) {
    balanceCache = { balance: null, error: 'No DeepSeek API key found in dsh', at: Date.now() }
    return
  }
  try {
    const json = (await fetchJson('https://api.deepseek.com/user/balance', BALANCE_FETCH_TIMEOUT_MS, { authorization: `Bearer ${key}` })) as any
    const info = json?.balance_infos?.[0]
    if (info) {
      balanceCache = {
        balance: { currency: String(info.currency ?? ''), total: String(info.total_balance ?? '') },
        at: Date.now(),
      }
    } else {
      balanceCache = { balance: null, error: 'No balance data returned', at: Date.now() }
    }
  } catch (e) {
    // undici 的 fetch 失败只给笼统的 "fetch failed"；真正原因（DNS 解析失败 /
    // 连接被拒 / TLS 握手失败）藏在 e.cause 里，带出来否则余额报错无法定位。
    const message = e instanceof Error ? e.message : String(e)
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined
    balanceCache = { balance: null, error: cause ? `${message} (${cause})` : message, at: Date.now() }
  }
}

/** Last fetched balance (undefined until the user clicks Balance). */
export function getDshBalance(): { balance: DshBalance | null; error?: string } | undefined {
  if (!balanceCache) return undefined
  return { balance: balanceCache.balance, error: balanceCache.error }
}
