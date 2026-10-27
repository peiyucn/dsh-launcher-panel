import { isBrowserChoice, type BrowserChoice } from './webview/panel-contract.ts'

interface InstanceFormPayload {
  mode: 'new' | 'edit'
  id: string
  name: string
  home: string
  autoOpenBrowser?: boolean
  browser?: BrowserChoice
}

type InstanceFormParseResult =
  | { ok: true; form: InstanceFormPayload }
  | { ok: false; message: string }

const MALFORMED = 'Malformed instance form'
const REQUIRED = 'Name and home are required'

/** Untrusted client input: every field is type-checked here, not in the modal. */
export function parseInstanceFormPayload(raw: unknown): InstanceFormParseResult {
  if (typeof raw !== 'string') return { ok: false, message: MALFORMED }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, message: MALFORMED }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, message: MALFORMED }
  const payload = value as Record<string, unknown>
  if (typeof payload.name !== 'string' || typeof payload.home !== 'string') return { ok: false, message: REQUIRED }
  return {
    ok: true,
    form: {
      mode: payload.mode === 'edit' ? 'edit' : 'new',
      id: typeof payload.id === 'string' ? payload.id : '',
      name: payload.name,
      home: payload.home,
      autoOpenBrowser: typeof payload.autoOpenBrowser === 'boolean' ? payload.autoOpenBrowser : undefined,
      browser: isBrowserChoice(payload.browser) ? payload.browser : undefined,
    },
  }
}
