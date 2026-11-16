import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveDshHome } from '../dsh/paths.ts'
import { toEnglish } from '../shared/env.ts'

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
  /** Model API components only, in status-page order. */
  components: DsComponentStatus[]
  /** The official chat service component, when the status page reports it. */
  chat?: DsComponentStatus
  /** Active incidents that affect a monitored model or the chat service. */
  incidents: DsIncident[]
  /** Epoch ms of the status-page read that produced this snapshot. */
  checkedAt: number
}

export interface DshBalance {
  currency: string
  total: string
}

const DS_STATUS_PAGE_ID = 6410630422455
const DS_STATUS_PATH = `/api/status-page/${DS_STATUS_PAGE_ID}/summary/active`

// status.deepseek.com's TLS listener rejects some clients (e.g. Windows schannel),
// so the CNAME backend is tried first and the custom domain kept as fallback.
const DS_STATUS_HOSTS = [
  'https://statuspage.flashcat.cloud',
  'https://status.deepseek.com',
]

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
const HAS_DEEPSEEK_MODEL_CACHE_TTL_MS = 30_000
const HAS_DEEPSEEK_MODEL_CACHE_MAX = 32

let dsStatusCache: { status: DsStatus; at: number } | undefined
let dsStatusInFlight: Promise<DsStatus> | undefined
const balanceCache = new Map<string, { balance: DshBalance | null; error?: string; at: number }>()
const hasDeepSeekModelCache = new Map<string, { value: boolean; at: number }>()

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

/** Cold-cache fetches are coalesced: the refresh tick and a click can both ask. */
export function getDsStatus(): Promise<DsStatus> {
  const cached = dsStatusCache
  if (cached && Date.now() - cached.at < DS_STATUS_CACHE_TTL_MS) return Promise.resolve(cached.status)
  dsStatusInFlight ??= fetchDsStatus()
    .then((status) => {
      dsStatusCache = { status, at: Date.now() }
      return status
    })
    .finally(() => { dsStatusInFlight = undefined })
  return dsStatusInFlight
}

async function fetchDsStatus(): Promise<DsStatus> {
  for (const host of DS_STATUS_HOSTS) {
    try {
      return parseDsStatus(await fetchJson(`${host}${DS_STATUS_PATH}`, FETCH_TIMEOUT_MS))
    } catch {
      // Try the next host.
    }
  }
  return { state: 'unknown', components: [], incidents: [], checkedAt: Date.now() }
}

/**
 * The status page names model APIs "DeepSeek V4 Pro API服务(API Service)" and
 * everything else after its function (search/fetch APIs, chat services). Only
 * the DeepSeek-named models are monitored, so this returns a kebab-case id for
 * those and `undefined` for any other component.
 */
export function dsModelLabel(componentName: string): string | undefined {
  const english = toEnglish(componentName)
  if (!/^deepseek\b/i.test(english)) return undefined
  return english
    .toLowerCase()
    .replace(/\s+api$/, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

export function parseDsStatus(json: unknown): DsStatus {
  try {
    const root = asObject(json)
    const data = asObject(root.data)
    const page = asObject(data.page)
    const statusById = new Map<string, string>()
    const monitored: Array<{ id: string; name: string; order: number }> = []
    let chatId = ''
    for (const rawComponent of asArray(page.components)) {
      const c = asObject(rawComponent)
      const id = asString(c.component_id)
      if (!id) continue
      const rawName = asString(c.name)
      const name = dsModelLabel(rawName)
      if (name !== undefined) {
        statusById.set(id, 'operational')
        monitored.push({ id, name, order: Number(c.order_id ?? 0) || 0 })
      } else if (chatId === '' && /chat/i.test(rawName)) {
        // The chat service is named in the Chinese half ("对话服务(Chatservice)"), so
        // match the raw label instead of the stripped English half.
        chatId = id
        statusById.set(id, 'operational')
      }
    }
    monitored.sort((a, b) => a.order - b.order)

    const incidents: DsIncident[] = []
    for (const rawChange of asArray(data.active_changes)) {
      const ch = asObject(rawChange)
      const affected = asArray(ch.affected_components)
      // The page also reports search/file-upload outages; keep only incidents that
      // touch a monitored model or the chat service.
      if (!affected.some((rawAffected) => statusById.has(asString(asObject(rawAffected).component_id)))) continue
      incidents.push({ title: toEnglish(asString(ch.title)), status: asString(ch.status).trim() })
      for (const rawAffected of affected) {
        const ac = asObject(rawAffected)
        const id = asString(ac.component_id)
        const st = asString(ac.status).trim()
        if (id !== '' && statusById.has(id) && DS_SEVERITY[st] !== undefined) statusById.set(id, st)
      }
    }

    const components: DsComponentStatus[] = monitored.map((c) => ({
      name: c.name,
      status: (statusById.get(c.id) ?? 'operational') as DsComponentStatus['status'],
    }))
    const chat: DsComponentStatus | undefined = chatId === ''
      ? undefined
      : { name: 'chat-service', status: (statusById.get(chatId) ?? 'operational') as DsComponentStatus['status'] }

    const all: DsComponentStatus[] = chat ? [...components, chat] : components
    let worst = 'operational'
    for (const c of all) {
      if ((DS_SEVERITY[c.status] ?? 0) > (DS_SEVERITY[worst] ?? 0)) worst = c.status
    }
    const state: DsStatus['state'] = worst === 'full_outage' || worst === 'partial_outage'
      ? 'down'
      : worst === 'degraded'
        ? 'degraded'
        : worst === 'maintenance' ? 'maintenance' : 'ok'

    return { state, components, chat, incidents, checkedAt: Date.now() }
  } catch {
    return { state: 'unknown', components: [], incidents: [], checkedAt: Date.now() }
  }
}

export function readCredentialFromFile(name: string, file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n')
    // Values must sit on the key's own line, so a valueless parent key (dsh's
    // `refs:` block) cannot swallow the next line's key.
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

// Same precedence as dsh: inherited env wins, then $DSH_HOME's credentials store,
// then cwd's .env, then $DSH_HOME/.env.
function readCredential(name: string, home = resolveDshHome()): string | undefined {
  if (process.env[name]) return process.env[name]
  return readCredentialFromFile(name, path.join(home, '.credentials.yaml'))
    ?? readCredentialFromFile(name, path.join(process.cwd(), '.env'))
    ?? readCredentialFromFile(name, path.join(home, '.env'))
}

export function readDefaultModel(home = resolveDshHome()): { provider: string; model: string } | undefined {
  try {
    const lines = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8').split(/\r?\n/)
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

/** Cached per resolved home: the panel asks on every refresh and this does several file reads. */
export function hasDeepSeekModel(home = resolveDshHome()): boolean {
  const key = path.resolve(home)
  const now = Date.now()
  const cached = hasDeepSeekModelCache.get(key)
  if (cached && now - cached.at < HAS_DEEPSEEK_MODEL_CACHE_TTL_MS) return cached.value
  let value = !!readCredential('DEEPSEEK_API_KEY', home)
  if (!value) {
    const selection = readDefaultModel(home)
    value = selection !== undefined && /deepseek/i.test(`${selection.provider} ${selection.model}`)
  }
  // The cap keeps a pathological settings list from growing the cache unbounded.
  if (hasDeepSeekModelCache.size >= HAS_DEEPSEEK_MODEL_CACHE_MAX) hasDeepSeekModelCache.clear()
  hasDeepSeekModelCache.set(key, { value, at: now })
  return value
}

/** Test hook: drop the module caches so a test starts cold. */
export function resetDsCachesForTest(): void {
  dsStatusCache = undefined
  dsStatusInFlight = undefined
  hasDeepSeekModelCache.clear()
}

function setBalance(home: string, entry: { balance: DshBalance | null; error?: string }): void {
  balanceCache.set(path.resolve(home), { ...entry, at: Date.now() })
}

export async function fetchDshBalance(home = resolveDshHome()): Promise<void> {
  const key = readCredential('DEEPSEEK_API_KEY', home)
  if (!key) {
    setBalance(home, { balance: null, error: 'No DeepSeek API key found in dsh' })
    return
  }
  try {
    const json = asObject(await fetchJson('https://api.deepseek.com/user/balance', BALANCE_FETCH_TIMEOUT_MS, { authorization: `Bearer ${key}` }))
    const rawInfo = asArray(json.balance_infos)[0]
    const info = rawInfo === undefined ? undefined : asObject(rawInfo)
    setBalance(home, info
      ? { balance: { currency: asString(info.currency), total: asString(info.total_balance) } }
      : { balance: null, error: 'No balance data returned' })
  } catch (e) {
    // fetch() hides the real cause (DNS / refused / TLS) in e.cause; surface it.
    const message = e instanceof Error ? e.message : String(e)
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined
    setBalance(home, { balance: null, error: cause ? `${message} (${cause})` : message })
  }
}

export function getDshBalance(home = resolveDshHome()): { balance: DshBalance | null; error?: string } | undefined {
  return balanceCache.get(path.resolve(home))
}
