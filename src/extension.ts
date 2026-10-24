import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  actionCreateInstance,
  actionDeleteInstance,
  actionEditInstance,
  actionOpen,
  actionSelectInstance,
  actionStart,
  actionStop,
} from './actions.ts'
import { DshPanelProvider } from './panel.ts'
import { getInstanceManager, InstanceManager, setInstanceManager } from './instance-manager.ts'
import { dshBaseDir } from './paths.ts'
import { STATUS_BAR_REFRESH_INTERVAL_MS } from './timing.ts'
import { dbg, migrateLegacyDshConfig, setLogPath, stopLogTail } from './server.ts'
import { buildStatusMenuItems, buildStatusMenuSummary, type StatusMenuAction } from './statusMenu.ts'

const STATUS_SPIN_INTERVAL_MS = 150
// Running state paints its own background + foreground as theme colors
// (contributed in package.json), so the item stays readable on any theme.
const RUNNING_BACKGROUND_COLOR = 'dsh.statusBar.runningBackground'
const RUNNING_FOREGROUND_COLOR = 'dsh.statusBar.runningForeground'
// Status bar uses the launcher's own icon font (resources/dsh-icon.woff,
// derived from the 🐳 artwork — see NOTICE): a whale glyph plus two splash
// frames that are alternated while starting/installing, so the spout pulses.
const STATUS_TEXT = '$(dsh-whale)'
const STATUS_SPLASH_SMALL = '$(dsh-whale-splash-small)'
const STATUS_SPLASH_LARGE = '$(dsh-whale-splash-large)'

/** A quick-pick row; only the action rows carry an action. */
type MenuPick = vscode.QuickPickItem & { action?: StatusMenuAction; instanceId?: string }

export function activate(context: vscode.ExtensionContext): void {
  setLogPath(path.join(dshBaseDir(), 'logs', 'client.log'))
  dbg('activated')
  void migrateLegacyDshConfig()

  const manager = new InstanceManager(context)
  setInstanceManager(manager)
  void manager.ready().then(() => manager.refresh()).catch((error) => {
    dbg(`manager initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  const panelProvider = new DshPanelProvider(context.extension.packageJSON.version ?? '0.0.0')
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'dsh.statusMenu'
  statusBar.show()

  let spinnerTimer: ReturnType<typeof setInterval> | undefined
  const stopSpinner = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer)
      spinnerTimer = undefined
    }
  }

  const refreshStatusBar = async (): Promise<void> => {
    if (!getInstanceManager()) return
    const dashboard = await manager.dashboard()
    const status = dashboard.status
    const active = dashboard.active
    const runningCount = dashboard.instances.filter((instance) => instance.running).length
    const multiRunning = runningCount > 1 ? ` · ${runningCount} instances running` : ''
    const label = active?.name ? ` · ${active.name}` : ''
    if (status.running) {
      stopSpinner()
      statusBar.text = STATUS_TEXT
      statusBar.backgroundColor = new vscode.ThemeColor(RUNNING_BACKGROUND_COLOR)
      statusBar.color = new vscode.ThemeColor(RUNNING_FOREGROUND_COLOR)
      statusBar.tooltip = `DSH Launcher Panel${label} running at ${status.url}${multiRunning} — click for options`
    } else if (status.starting || status.installing || status.updating) {
      stopSpinner()
      statusBar.text = STATUS_SPLASH_SMALL
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = status.updating
        ? `DSH Launcher Panel${label} updating${multiRunning} — click for options`
        : (status.installing ? `DSH Launcher Panel${label} installing${multiRunning} — click for options` : `DSH Launcher Panel${label} starting${multiRunning} — click for options`)
      spinnerTimer = setInterval(() => {
        statusBar.text = statusBar.text === STATUS_SPLASH_SMALL ? STATUS_SPLASH_LARGE : STATUS_SPLASH_SMALL
      }, STATUS_SPIN_INTERVAL_MS)
    } else if (status.stopping) {
      stopSpinner()
      statusBar.text = STATUS_TEXT
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = `DSH Launcher Panel${label} stopping${multiRunning} — click for options`
    } else {
      stopSpinner()
      statusBar.text = STATUS_TEXT
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = `DSH Launcher Panel${label} stopped${multiRunning} — click for options`
    }
  }

  void refreshStatusBar().catch(() => {})
  const statusTimer = setInterval(() => void refreshStatusBar().catch(() => {}), STATUS_BAR_REFRESH_INTERVAL_MS)

  const runMenuAction = async (action: StatusMenuAction): Promise<void> => {
    switch (action) {
      case 'start':
      case 'open':
        await actionStart()
        break
      case 'stop':
        await actionStop()
        break
      case 'dashboard':
        try {
          await vscode.commands.executeCommand('dsh.panel.focus')
        } catch {
          await vscode.commands.executeCommand('workbench.view.extension.dsh')
        }
        break
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:peiyucn.dsh-launcher-panel')
        break
    }
  }

  context.subscriptions.push(
    statusBar,
    { dispose: () => { clearInterval(statusTimer); stopSpinner() } },
    vscode.commands.registerCommand('dsh.statusMenu', async () => {
      const dashboard = await manager.dashboard()
      const active = dashboard.active
      const running = dashboard.instances.filter((instance) => instance.running)
      const showRunning = running.length > 1 || (running.length === 1 && !active?.running)
      const items: MenuPick[] = [
        { label: buildStatusMenuSummary(dashboard.status, active?.name), kind: vscode.QuickPickItemKind.Separator },
      ]
      if (showRunning) {
        items.push({ label: running.length > 1 ? `${running.length} running instances` : 'Running instance', kind: vscode.QuickPickItemKind.Separator })
        for (const instance of running) {
          items.push({
            label: instance.name,
            description: `:${instance.port}${instance.id === active?.id ? ' · active' : ''}`,
            iconPath: new vscode.ThemeIcon('globe'),
            instanceId: instance.id,
          })
        }
      }
      items.push(...buildStatusMenuItems(dashboard.status, active?.name).map((item) => ({
        label: item.label,
        iconPath: new vscode.ThemeIcon(item.icon),
        action: item.action,
      })))
      const picked = await vscode.window.showQuickPick(items, {
        title: 'DSH Launcher Panel',
        placeHolder: active?.name ? `${active.name} — choose an action` : 'Choose an action',
      })
      if (picked?.instanceId) {
        await manager.select(picked.instanceId)
        await actionOpen(picked.instanceId)
        void refreshStatusBar().catch(() => {})
        return
      }
      if (picked?.action) {
        await runMenuAction(picked.action)
        void refreshStatusBar().catch(() => {})
      }
    }),
    vscode.commands.registerCommand('dsh.start', async () => {
      await actionStart()
      void refreshStatusBar().catch(() => {})
    }),
    vscode.commands.registerCommand('dsh.stop', async () => {
      await actionStop()
      void refreshStatusBar().catch(() => {})
    }),
    vscode.commands.registerCommand('dsh.instance.new', () => actionCreateInstance()),
    vscode.commands.registerCommand('dsh.instance.edit', () => actionEditInstance()),
    vscode.commands.registerCommand('dsh.instance.delete', () => actionDeleteInstance()),
    vscode.commands.registerCommand('dsh.instance.select', () => actionSelectInstance()),
    vscode.commands.registerCommand('dsh.instance.open', () => actionOpen()),
  )
}

export function deactivate(): void {
  // The servers are intentionally left running; Stop them from the panel or the
  // DSH Launcher Panel: Stop command. Log pumps belong to this host and stop with
  // it; each server keeps writing its own log file regardless.
  getInstanceManager()?.dispose()
  stopLogTail()
}
