export type StatusMenuAction = 'start' | 'stop' | 'open' | 'dashboard' | 'settings'

interface StatusMenuItem {
  label: string
  icon: string
  action: StatusMenuAction
}

interface MenuStatus {
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  updating: boolean
  external: boolean
  uiAvailable: boolean
  dshVersion: string
  mode: 'pnpm' | 'source'
  url: string
}

type Phase = 'running' | 'starting' | 'busy' | 'stopped'
type PhaseAction = Exclude<StatusMenuAction, 'settings'>

const PHASE_ACTIONS: Record<Phase, readonly PhaseAction[]> = {
  running: ['open', 'dashboard', 'stop'], starting: ['dashboard', 'stop'], busy: ['dashboard'], stopped: ['start', 'dashboard'],
}

function phaseActions(
  status: Pick<MenuStatus, 'running' | 'starting' | 'installing' | 'stopping' | 'updating' | 'external' | 'uiAvailable'>,
): readonly PhaseAction[] {
  const phase = phaseOf(status)
  if (!status.external) return PHASE_ACTIONS[phase]
  // The launcher only observes external instances: no start, no stop, no restart.
  if (phase === 'running') return status.uiAvailable ? ['open', 'dashboard'] : ['dashboard']
  return ['dashboard']
}

const ACTION_ICONS: Record<StatusMenuAction, string> = { start: 'play', stop: 'debug-stop', open: 'globe', dashboard: 'browser', settings: 'settings-gear' }

const STATE_WORDS: ReadonlyArray<readonly [keyof MenuStatus, string]> = [
  ['running', 'Running'], ['starting', 'Starting'], ['installing', 'Installing'], ['updating', 'Updating'], ['stopping', 'Stopping'],
]

function instanceLabel(instanceName?: string): string {
  return instanceName?.trim() ?? ''
}

function phaseOf(status: Pick<MenuStatus, 'running' | 'starting' | 'installing' | 'stopping' | 'updating'>): Phase {
  if (status.running) return 'running'
  if (status.starting || status.installing) return 'starting'
  if (status.stopping || status.updating) return 'busy'
  return 'stopped'
}

function menuItem(action: PhaseAction, name: string): StatusMenuItem {
  const label = {
    open: [`Open ${name} Web UI`, 'Open Web UI'],
    stop: [`Stop ${name} Web UI`, 'Stop DSH Web UI'],
    start: [`Start ${name} & Open Web UI`, 'Start & Open Web UI'],
    dashboard: ['Open Dashboard', 'Open Dashboard'],
  }[action][name ? 0 : 1]
  return { label, icon: ACTION_ICONS[action], action }
}

export function buildStatusMenuItems(
  status: Pick<MenuStatus, 'running' | 'starting' | 'installing' | 'stopping' | 'updating' | 'external' | 'uiAvailable'>,
  instanceName?: string,
): StatusMenuItem[] {
  const name = instanceLabel(instanceName)
  const items = phaseActions(status).map((action) => menuItem(action, name))
  items.push({ label: 'Open Global Settings', icon: ACTION_ICONS.settings, action: 'settings' })
  return items
}

function stateWord(status: MenuStatus): string {
  for (const [key, word] of STATE_WORDS) if (status[key]) return word
  return 'Stopped'
}

export function buildStatusMenuSummary(status: MenuStatus, instanceName?: string): string {
  const name = instanceLabel(instanceName)
  const parts = name ? [name] : []
  parts.push(stateWord(status), status.mode === 'source' ? 'src mode' : 'pkg mode')
  if (status.external) parts.push('external')
  parts.push(status.dshVersion ? `dsh v${status.dshVersion}` : 'dsh version unknown')
  if (status.running) parts.push(status.url.replace(/^https?:\/\//, ''))
  return parts.join(' · ')
}
