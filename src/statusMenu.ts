import type { ServerStatus } from './server.ts'

export type StatusMenuAction = 'start' | 'stop' | 'open' | 'dashboard' | 'settings'

export interface StatusMenuItem {
  label: string
  /** Codicon id shown as the quick-pick icon. */
  icon: string
  action: StatusMenuAction
}

/**
 * What the status-bar menu may read to summarize the current run. A Pick, not
 * the whole ServerStatus, so the menu cannot start depending on state it has no
 * business reading.
 */
export type MenuStatus = Pick<
  ServerStatus,
  'running' | 'starting' | 'installing' | 'stopping' | 'updating' | 'dshVersion' | 'mode' | 'url'
>

const OPEN_SETTINGS: StatusMenuItem = { label: 'Open Global Settings', icon: 'settings-gear', action: 'settings' }

/**
 * Contextual quick-pick menu for the status bar DSH Launcher Panel item:
 * clicking the item opens this menu (matching the behaviour of other status bar
 * entries) instead of starting the server directly.
 */
export function buildStatusMenuItems(
  status: Pick<ServerStatus, 'running' | 'starting' | 'installing' | 'stopping' | 'updating'>,
  instanceName?: string,
): StatusMenuItem[] {
  const name = instanceName && instanceName.trim() !== '' ? instanceName.trim() : ''
  const openLabel = name ? `Open ${name} Web UI` : 'Open Web UI'
  const stopLabel = name ? `Stop ${name} Web UI` : 'Stop DSH Web UI'
  const startLabel = name ? `Start ${name} & Open Web UI` : 'Start & Open Web UI'
  let items: StatusMenuItem[]
  if (status.running) {
    items = [
      { label: openLabel, icon: 'globe', action: 'open' },
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
      { label: stopLabel, icon: 'debug-stop', action: 'stop' },
    ]
  } else if (status.starting || status.installing) {
    items = [
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
      { label: stopLabel, icon: 'debug-stop', action: 'stop' },
    ]
  } else if (status.stopping || status.updating) {
    // An update rewrites the checkout / package tree; offering Start here would
    // hit the server-side refusal anyway, so don't offer it.
    items = [{ label: 'Open Dashboard', icon: 'browser', action: 'dashboard' }]
  } else {
    items = [
      { label: startLabel, icon: 'play', action: 'start' },
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
    ]
  }
  items.push(OPEN_SETTINGS)
  return items
}

/** The lifecycle state, worded the same way the panel reports it. */
function stateWord(status: MenuStatus): string {
  if (status.running) return 'Running'
  if (status.starting) return 'Starting'
  if (status.installing) return 'Installing'
  if (status.updating) return 'Updating'
  if (status.stopping) return 'Stopping'
  return 'Stopped'
}

/**
 * One-line summary of the current run, shown as the header of the status-bar
 * quick pick. It answers "what is it doing?" before the actions ask "what
 * next?", so the menu is useful without opening the Dashboard. The endpoint is
 * only shown while the server is up — otherwise it would read like a claim.
 */
export function buildStatusMenuSummary(status: MenuStatus, instanceName?: string): string {
  const parts = instanceName ? [instanceName] : []
  parts.push(stateWord(status), status.mode === 'source' ? 'src mode' : 'pkg mode')
  parts.push(status.dshVersion ? `dsh v${status.dshVersion}` : 'dsh version unknown')
  // displayUrl() always yields "http://127.0.0.1:<port>"; the scheme is noise in
  // a one-line summary.
  if (status.running) parts.push(status.url.replace(/^https?:\/\//, ''))
  return parts.join(' · ')
}
