/**
 * Parsing the instance-form payload the webview sends back.
 *
 * The webview hands the modal's fields to the host as one JSON string (the
 * message bridge carries strings only — see `panel-script.ts`). This module is
 * the trust boundary for that string: whatever the client sends is untrusted, so
 * every field is type-checked here instead of relying on the modal to be
 * well-behaved. Extracted from `panel.ts` so the rules can be unit-tested
 * without loading VS Code.
 *
 * Pure logic — no VS Code import.
 *
 * @module panel-form
 */

import { isBrowserChoice, type BrowserChoice } from './webview/panel-contract.ts'

/** The validated fields of one create/edit form submission. */
export interface InstanceFormPayload {
  mode: 'new' | 'edit'
  /**
   * Instance id for an edit. `''` when the client did not send one; the host
   * reports "Instance was not found" for that case (same as an unknown id).
   */
  id: string
  name: string
  home: string
  autoOpenBrowser?: boolean
  browser?: BrowserChoice
}

export type InstanceFormParseResult =
  | { ok: true; form: InstanceFormPayload }
  | { ok: false; message: string }

/** Shown when the payload is not a JSON object at all. */
const MALFORMED_MESSAGE = 'Malformed instance form'
/** Shown when the payload is an object but the required text fields are wrong. */
const REQUIRED_FIELDS_MESSAGE = 'Name and home are required'

/**
 * Validate one raw `saveInstanceForm` value.
 *
 * Non-object input (including `undefined`, which the host passes through when
 * the message carried no `value`) and invalid JSON are "malformed"; an object
 * whose name/home are not strings is reported as missing fields.
 */
export function parseInstanceFormPayload(raw: unknown): InstanceFormParseResult {
  if (typeof raw !== 'string') return { ok: false, message: MALFORMED_MESSAGE }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, message: MALFORMED_MESSAGE }
  }
  // Arrays pass `typeof === 'object'` but carry no fields; treat them as
  // malformed rather than as an object with missing name/home.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: MALFORMED_MESSAGE }
  }
  const payload = value as Record<string, unknown>
  if (typeof payload.name !== 'string' || typeof payload.home !== 'string') {
    return { ok: false, message: REQUIRED_FIELDS_MESSAGE }
  }
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
