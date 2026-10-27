/**
 * The host ⇄ panel message contract.
 *
 * The client script ships as one string (`panel-script.ts`), so it cannot import
 * these constants itself — the host is the only code that can. Keeping the
 * command / message-type / payload definitions in one place still pays off:
 * `test/panel-contract.test.ts` extracts the literals from the generated HTML and
 * script and compares them against this module, which is what stops the host
 * switch, the body markup and the client script from drifting apart silently.
 *
 * This module is pure TypeScript. Importing it must never load VS Code, so it is
 * safe for the tests and for any layer.
 *
 * @module webview/panel-contract
 */

import { DEFAULT_BROWSER } from '../env.ts'
import type { DsStatus, DshBalance } from '../ds.ts'
import type { PricingWindow } from '../pricing.ts'

/** Commands the webview posts to the host. */
export const PANEL_COMMANDS = {
  /** Posted once by the client as soon as the script has run. */
  ready: 'ready',
  start: 'start',
  stop: 'stop',
  instanceForm: 'instanceForm',
  saveInstanceForm: 'saveInstanceForm',
  selectInstance: 'selectInstance',
  deleteInstance: 'deleteInstance',
  updateDsh: 'updateDsh',
  refreshRequirements: 'refreshRequirements',
  setMode: 'setMode',
  revealPath: 'revealPath',
  openLog: 'openLog',
  balance: 'balance',
  setBrowser: 'setBrowser',
  openStatus: 'openStatus',
  openSettings: 'openSettings',
  toggleDebug: 'toggleDebug',
  clearConsole: 'clearConsole',
} as const

export type PanelCommand = (typeof PANEL_COMMANDS)[keyof typeof PANEL_COMMANDS]

/** Message types the host posts to the webview. */
export const PANEL_MESSAGE_TYPES = {
  update: 'update',
  instanceForm: 'instanceForm',
  instanceFormError: 'instanceFormError',
  instanceFormSaved: 'instanceFormSaved',
} as const

export type PanelMessageType = (typeof PANEL_MESSAGE_TYPES)[keyof typeof PANEL_MESSAGE_TYPES]

/** One raw message from the webview, before any per-command validation. */
export interface PanelMessage {
  command?: string
  /**
   * String payload; its meaning depends on the command (an instance id, the
   * `'new'` sentinel, an enum, or a JSON-encoded form — see `panel-form.ts`).
   */
  value?: string
}

/** Browser choices accepted at the host boundary (`dsh.browser`). */
export const BROWSER_CHOICES = ['built-in', 'external'] as const

export type BrowserChoice = (typeof BROWSER_CHOICES)[number]

/** Whether an untrusted value is one of the browser choices. */
export function isBrowserChoice(value: unknown): value is BrowserChoice {
  return value === 'built-in' || value === 'external'
}

/** The result of one update check, as the panel's Update button consumes it. */
export interface PanelUpdateInfo {
  hasUpdate: boolean
  label: string
  /** True when the check could not answer (network etc.) — not "no update". */
  failed?: boolean
  failedReason?: string
}

/**
 * The status block the panel renders.
 *
 * Mirrors the manager's dashboard status. `unknown` is panel-only: it is set
 * when a refresh failed and the previous snapshot is being shown, so the panel
 * can render "status unknown" instead of claiming the server stopped.
 */
export interface PanelStatus {
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  checking: boolean
  updating: boolean
  /** True when this is a fallback snapshot after a failed refresh. */
  unknown?: boolean
  url: string
  dsh: 'unknown' | 'ok' | 'missing'
  dshVersion: string
  dshPath: string
  dshHome: string
  dshPathShort: string
  dshHomeShort: string
  nodeVersion: string
  mode: 'pnpm' | 'source'
  update: PanelUpdateInfo | undefined
  consoleLogPath: string
  consoleLogPathShort: string
  serverLogPath: string
  serverLogPathShort: string
  consoleLogSize: number
  serverLogSize: number
  sourceDebug: boolean
}

export type PanelInstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * Per-instance fields the panel renders. Deliberately a subset of the runtime
 * status: fields the webview never reads (the launch-token URL among them) must
 * not force their way into the payload type.
 */
export interface PanelInstanceStatus {
  id: string
  name: string
  home: string
  port: number
  state: PanelInstanceState
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  error?: string
  homeShort?: string
  profile?: string
  url?: string
}

/** One settings/validation issue shown above the instance list. */
export interface PanelIssue {
  index: number
  field: string
  severity: 'error' | 'warning'
  message: string
}

/** One line of the panel activity feed. */
export interface PanelActivityEntry {
  id: number
  text: string
  busy: boolean
}

/** The balance block; `balance` is null when the query failed. */
export interface PanelBalance {
  balance: DshBalance | null
  error?: string
}

/** The dashboard snapshot sent with every `update` message. */
export interface PanelUpdate {
  type: 'update'
  status: PanelStatus
  instances: PanelInstanceStatus[]
  active: PanelInstanceStatus | undefined
  activeId: string
  issues: PanelIssue[]
  activity: PanelActivityEntry[]
  browser: BrowserChoice
  dsStatus: DsStatus | undefined
  balance: PanelBalance | undefined
  showDs: boolean
  pricing: PricingWindow
}

/**
 * Input to {@link buildPanelUpdate}. Only `status` and `pricing` are required:
 * the builder fills the rest so every branch (manager present, no manager,
 * refresh failed) posts the same field set the client consumes.
 */
export interface PanelUpdateInput {
  status: PanelStatus
  instances?: readonly PanelInstanceStatus[]
  active?: PanelInstanceStatus | undefined
  activeId?: string
  issues?: readonly PanelIssue[]
  activity?: readonly PanelActivityEntry[]
  browser?: BrowserChoice
  dsStatus?: DsStatus | undefined
  balance?: PanelBalance | undefined
  showDs?: boolean
  pricing: PricingWindow
}

/**
 * The only place an `update` payload is assembled: the three host branches all
 * call this, so a field the client reads can never be present in one branch and
 * missing in another.
 */
export function buildPanelUpdate(input: PanelUpdateInput): PanelUpdate {
  return {
    type: PANEL_MESSAGE_TYPES.update,
    status: { ...input.status, unknown: input.status.unknown === true },
    instances: [...(input.instances ?? [])],
    active: input.active,
    activeId: input.activeId ?? '',
    issues: [...(input.issues ?? [])],
    activity: [...(input.activity ?? [])],
    browser: input.browser ?? DEFAULT_BROWSER,
    dsStatus: input.dsStatus,
    balance: input.balance,
    showDs: input.showDs ?? false,
    pricing: input.pricing,
  }
}

/** Prefilled fields for the in-panel create/edit modal. */
export interface PanelInstanceForm {
  mode: 'new' | 'edit'
  id?: string
  name?: string
  home?: string
  homePrefix?: string
  autoOpenBrowser?: boolean
  browser?: BrowserChoice
}

export interface PanelInstanceFormMessage {
  type: 'instanceForm'
  form: PanelInstanceForm
}

export interface PanelInstanceFormErrorMessage {
  type: 'instanceFormError'
  message: string
}

export interface PanelInstanceFormSavedMessage {
  type: 'instanceFormSaved'
}

/** Every message the host may post; `update` is the periodic snapshot. */
export type PanelHostMessage =
  | PanelUpdate
  | PanelInstanceFormMessage
  | PanelInstanceFormErrorMessage
  | PanelInstanceFormSavedMessage
