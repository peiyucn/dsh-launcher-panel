import * as vscode from 'vscode'
import type { InstanceManager } from '../instances/manager.ts'
import { getInstanceManager } from '../instances/manager.ts'
import { STATUS_BAR_REFRESH_INTERVAL_MS } from '../shared/timing.ts'

const STATUS_SPIN_INTERVAL_MS = 150
const RUNNING_BACKGROUND_COLOR = 'dsh.statusBar.runningBackground'
const RUNNING_FOREGROUND_COLOR = 'dsh.statusBar.runningForeground'
const STATUS_TEXT = '$(dsh-whale)'
const STATUS_SPLASH_SMALL = '$(dsh-whale-splash-small)'
const STATUS_SPLASH_LARGE = '$(dsh-whale-splash-large)'

/** The status-bar item plus the refresh the commands need after an action. */
export interface StatusBar extends vscode.Disposable {
  refresh(): Promise<void>
}

export function createStatusBar(manager: InstanceManager): StatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  item.command = 'dsh.statusMenu'
  item.show()

  let spinnerTimer: ReturnType<typeof setInterval> | undefined
  const stopSpinner = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer)
      spinnerTimer = undefined
    }
  }

  const setStatusBar = (text: string, tooltip: string, running = false): void => {
    stopSpinner()
    item.text = text
    item.backgroundColor = running ? new vscode.ThemeColor(RUNNING_BACKGROUND_COLOR) : undefined
    item.color = running ? new vscode.ThemeColor(RUNNING_FOREGROUND_COLOR) : undefined
    item.tooltip = tooltip
  }

  const refresh = async (): Promise<void> => {
    if (!getInstanceManager()) return
    const dashboard = await manager.dashboard()
    const { status, active } = dashboard
    const runningCount = dashboard.instances.filter((instance) => instance.running).length
    const suffix = `${runningCount > 1 ? ` · ${runningCount} instances running` : ''} — click for options`
    const label = `DSH Launcher Panel${active?.name ? ` · ${active.name}` : ''}`
    if (status.running) {
      setStatusBar(STATUS_TEXT, `${label} running at ${status.url}${suffix}`, true)
    } else if (status.starting || status.installing || status.updating) {
      const state = status.updating ? 'updating' : status.installing ? 'installing' : 'starting'
      setStatusBar(STATUS_SPLASH_SMALL, `${label} ${state}${suffix}`)
      spinnerTimer = setInterval(() => {
        item.text = item.text === STATUS_SPLASH_SMALL ? STATUS_SPLASH_LARGE : STATUS_SPLASH_SMALL
      }, STATUS_SPIN_INTERVAL_MS)
    } else {
      setStatusBar(STATUS_TEXT, `${label} ${status.stopping ? 'stopping' : 'stopped'}${suffix}`)
    }
  }

  void refresh().catch(() => {})
  const timer = setInterval(() => void refresh().catch(() => {}), STATUS_BAR_REFRESH_INTERVAL_MS)

  return {
    refresh,
    dispose(): void {
      clearInterval(timer)
      stopSpinner()
      item.dispose()
    },
  }
}
