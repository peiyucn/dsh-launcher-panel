import type { ServerStatus } from './server'

export type StatusMenuAction = 'start' | 'stop' | 'open' | 'dashboard' | 'settings'

export interface StatusMenuItem {
  label: string
  /** Codicon id shown as the quick-pick icon. */
  icon: string
  action: StatusMenuAction
}

const OPEN_SETTINGS: StatusMenuItem = { label: 'Open Settings', icon: 'settings-gear', action: 'settings' }

/**
 * Contextual quick-pick menu for the status bar 🐳 DSH item: clicking the item
 * opens this menu (matching the behaviour of other status bar entries) instead
 * of starting the server directly.
 */
export function buildStatusMenuItems(
  status: Pick<ServerStatus, 'running' | 'starting' | 'installing' | 'stopping'>,
): StatusMenuItem[] {
  let items: StatusMenuItem[]
  if (status.running) {
    items = [
      { label: 'Open Web UI', icon: 'globe', action: 'open' },
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
      { label: 'Stop DeepSeek Harness', icon: 'debug-stop', action: 'stop' },
    ]
  } else if (status.starting || status.installing) {
    items = [
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
      { label: 'Stop DeepSeek Harness', icon: 'debug-stop', action: 'stop' },
    ]
  } else if (status.stopping) {
    items = [{ label: 'Open Dashboard', icon: 'browser', action: 'dashboard' }]
  } else {
    items = [
      { label: 'Start & Open Web UI', icon: 'play', action: 'start' },
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
    ]
  }
  items.push(OPEN_SETTINGS)
  return items
}
