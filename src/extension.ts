import * as path from 'node:path'
import * as vscode from 'vscode'
import { actionStart, actionStop } from './actions'
import { DshPanelProvider } from './panel'
import { dshBaseDir } from './common'
import { checkNodeOnce, currentStatus, dbg, registerConfigWatcher, setLogPath, stopLogTail } from './server'
import { buildStatusMenuItems, type StatusMenuAction } from './statusMenu'

const STATUS_REFRESH_INTERVAL_MS = 4_000
const STATUS_SPIN_INTERVAL_MS = 150
// Running state paints its own background + foreground as theme colors
// (contributed in package.json), so the item stays readable on any theme.
const RUNNING_BACKGROUND_COLOR = 'dsh.statusBar.runningBackground'
const RUNNING_FOREGROUND_COLOR = 'dsh.statusBar.runningForeground'
// Status bar uses the launcher's own icon font (resources/dsh-icon.woff,
// derived from the 🐳 artwork — see NOTICE): a whale glyph plus two splash
// frames that are alternated while starting/installing, so the spout pulses.
const STATUS_TEXT = '$(dsh-whale) DSH'
const STATUS_SPLASH_SMALL = '$(dsh-whale-splash-small) DSH'
const STATUS_SPLASH_LARGE = '$(dsh-whale-splash-large) DSH'

export function activate(context: vscode.ExtensionContext): void {
  setLogPath(path.join(dshBaseDir(), 'logs', 'client.log'))
  dbg('activated')
  // Node is probed exactly once, here, at activation.
  void checkNodeOnce()

  const panelProvider = new DshPanelProvider(context.extension.packageJSON.version ?? '0.0.0')
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(registerConfigWatcher())

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  // Clicking the item opens a command menu (like other status bar entries)
  // instead of starting the server directly.
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
    const status = await currentStatus()
    if (status.running) {
      stopSpinner()
      statusBar.text = STATUS_TEXT
      statusBar.backgroundColor = new vscode.ThemeColor(RUNNING_BACKGROUND_COLOR)
      statusBar.color = new vscode.ThemeColor(RUNNING_FOREGROUND_COLOR)
      statusBar.tooltip = `DeepSeek Harness running at ${status.url} — click for options`
    } else if (status.starting || status.installing) {
      stopSpinner()
      statusBar.text = STATUS_SPLASH_SMALL
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = status.installing ? 'DeepSeek Harness installing — click for options' : 'DeepSeek Harness starting — click for options'
      // Pulse the whale's spout between the small and large splash frames.
      spinnerTimer = setInterval(() => {
        statusBar.text = statusBar.text === STATUS_SPLASH_SMALL ? STATUS_SPLASH_LARGE : STATUS_SPLASH_SMALL
      }, STATUS_SPIN_INTERVAL_MS)
    } else if (status.stopping) {
      stopSpinner()
      statusBar.text = STATUS_TEXT
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = 'DeepSeek Harness stopping — click for options'
    } else {
      stopSpinner()
      statusBar.text = STATUS_TEXT
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = 'DeepSeek Harness stopped — click for options'
    }
  }

  void refreshStatusBar().catch(() => {})
  const statusTimer = setInterval(() => void refreshStatusBar().catch(() => {}), STATUS_REFRESH_INTERVAL_MS)

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
    }
  }

  context.subscriptions.push(
    statusBar,
    { dispose: () => { clearInterval(statusTimer); stopSpinner() } },
    vscode.commands.registerCommand('dsh.statusMenu', async () => {
      const items = buildStatusMenuItems(await currentStatus()).map((item) => ({
        label: item.label,
        iconPath: new vscode.ThemeIcon(item.icon),
        action: item.action,
      }))
      const picked = await vscode.window.showQuickPick(items, {
        title: '🐳 DSH',
        placeHolder: 'DeepSeek Harness — choose an action',
      })
      if (picked) await runMenuAction(picked.action)
    }),
    vscode.commands.registerCommand('dsh.start', () => actionStart()),
    vscode.commands.registerCommand('dsh.stop', () => actionStop()),
  )
}

export function deactivate(): void {
  // The server is intentionally left running. Stop it from the panel or the
  // DSH Launcher Panel: Stop command. The log tailer belongs to this host,
  // so it stops with it (the server keeps writing the log file regardless).
  stopLogTail()
}
