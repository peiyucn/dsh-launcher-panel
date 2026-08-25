import type { ServerStatus } from './server'

export type StatusMenuAction = 'start' | 'stop' | 'open' | 'dashboard'

export interface StatusMenuItem {
  label: string
  /** Codicon id shown as the quick-pick icon. */
  icon: string
  action: StatusMenuAction
}

/**
 * Contextual quick-pick menu for the status bar 🐳 DSH item: clicking the item
 * opens this menu (matching the behaviour of other status bar entries) instead
 * of starting the server directly.
 */
export function buildStatusMenuItems(
  status: Pick<ServerStatus, 'running' | 'starting' | 'installing' | 'stopping'>,
): StatusMenuItem[] {
  if (status.running) {
    return [
      { label: 'Open Web UI', icon: 'globe', action: 'open' },
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
      { label: 'Stop DeepSeek Harness', icon: 'debug-stop', action: 'stop' },
    ]
  }
  if (status.starting || status.installing) {
    return [
      { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
      { label: 'Stop DeepSeek Harness', icon: 'debug-stop', action: 'stop' },
    ]
  }
  if (status.stopping) {
    return [{ label: 'Open Dashboard', icon: 'browser', action: 'dashboard' }]
  }
  return [
    { label: 'Start & Open Web UI', icon: 'play', action: 'start' },
    { label: 'Open Dashboard', icon: 'browser', action: 'dashboard' },
  ]
}
