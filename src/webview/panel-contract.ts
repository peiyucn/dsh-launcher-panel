import { DEFAULT_BROWSER } from '../env.ts'
import type { DsStatus, DshBalance } from '../ds.ts'
import type { PricingWindow } from '../pricing.ts'

const COMMAND_NAMES = [
  'ready', 'start', 'stop', 'instanceForm', 'saveInstanceForm', 'selectInstance',
  'deleteInstance', 'updateDsh', 'refreshRequirements', 'setMode', 'revealPath', 'openLog',
  'balance', 'setBrowser', 'openStatus', 'openSettings', 'toggleDebug', 'clearConsole',
] as const

const MESSAGE_TYPE_NAMES = ['update', 'instanceForm', 'instanceFormError', 'instanceFormSaved'] as const

/** Name → same-name map keeps the literal union and the runtime values from one list. */
function sameNameMap<T extends readonly string[]>(names: T): { readonly [K in T[number]]: K } {
  return Object.fromEntries(names.map((name) => [name, name])) as { readonly [K in T[number]]: K }
}

export const PANEL_COMMANDS = sameNameMap(COMMAND_NAMES)
export const PANEL_MESSAGE_TYPES = sameNameMap(MESSAGE_TYPE_NAMES)

/** One raw webview message; `value` meaning depends on the command. */
export interface PanelMessage {
  command?: string
  value?: string
}

export const BROWSER_CHOICES = ['built-in', 'external'] as const

export type BrowserChoice = (typeof BROWSER_CHOICES)[number]

export function isBrowserChoice(value: unknown): value is BrowserChoice {
  return typeof value === 'string' && (BROWSER_CHOICES as readonly string[]).includes(value)
}

interface PanelUpdateInfo {
  hasUpdate: boolean
  label: string
  failed?: boolean
  failedReason?: string
}

export interface PanelStatus {
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  checking: boolean
  updating: boolean
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

interface PanelInstanceStatus {
  id: string
  name: string
  home: string
  port: number
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  error?: string
  homeShort?: string
  profile?: string
  url?: string
}

interface PanelIssue {
  index: number
  field: string
  severity: 'error' | 'warning'
  message: string
}

interface PanelActivityEntry {
  id: number
  text: string
  busy: boolean
}

interface PanelBalance {
  balance: DshBalance | null
  error?: string
}

/** Only `status` and `pricing` are required; every branch posts the same field set. */
interface PanelUpdateInput {
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

export interface PanelUpdate extends Required<Omit<PanelUpdateInput, 'active' | 'dsStatus' | 'balance'>> {
  type: typeof PANEL_MESSAGE_TYPES.update
  active: PanelInstanceStatus | undefined
  dsStatus: DsStatus | undefined
  balance: PanelBalance | undefined
}

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

export interface PanelInstanceForm {
  mode: 'new' | 'edit'
  id?: string
  name?: string
  home?: string
  homePrefix?: string
  autoOpenBrowser?: boolean
  browser?: BrowserChoice
}

type PanelInstanceFormMessage = { type: typeof PANEL_MESSAGE_TYPES.instanceForm; form: PanelInstanceForm }
type PanelInstanceFormErrorMessage = { type: typeof PANEL_MESSAGE_TYPES.instanceFormError; message: string }
type PanelInstanceFormSavedMessage = { type: typeof PANEL_MESSAGE_TYPES.instanceFormSaved }
export type PanelHostMessage =
  | PanelUpdate
  | PanelInstanceFormMessage
  | PanelInstanceFormErrorMessage
  | PanelInstanceFormSavedMessage
