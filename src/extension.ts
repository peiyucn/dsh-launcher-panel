import * as path from 'node:path'
import * as vscode from 'vscode'
import { actionStart, actionStop } from './actions'
import { DshPanelProvider } from './panel'
import { dshBaseDir } from './common'
import { checkNodeOnce, currentStatus, dbg, registerConfigWatcher, setLogPath, stopLogTail } from './server'

const STATUS_REFRESH_INTERVAL_MS = 4_000
const STATUS_SPIN_INTERVAL_MS = 150
// Running state paints its own background + foreground as theme colors
// (contributed in package.json), so the item stays readable on any theme.
const RUNNING_BACKGROUND_COLOR = 'dsh.statusBar.runningBackground'
const RUNNING_FOREGROUND_COLOR = 'dsh.statusBar.runningForeground'

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
  statusBar.command = 'dsh.start'
  statusBar.show()

  const SPIN_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
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
      statusBar.text = '🐳\uFE0E DSH'
      statusBar.backgroundColor = new vscode.ThemeColor(RUNNING_BACKGROUND_COLOR)
      statusBar.color = new vscode.ThemeColor(RUNNING_FOREGROUND_COLOR)
      statusBar.tooltip = `DeepSeek Harness running at ${status.url} — click to open`
    } else if (status.starting || status.installing) {
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = status.installing ? 'DeepSeek Harness installing — click to open when ready' : 'DeepSeek Harness starting — click to open when ready'
      if (!spinnerTimer) {
        let i = 0
        statusBar.text = '🐳\uFE0E DSH ⠋'
        spinnerTimer = setInterval(() => {
          statusBar.text = `🐳\uFE0E DSH ${SPIN_CHARS[i++ % SPIN_CHARS.length]}`
        }, STATUS_SPIN_INTERVAL_MS)
      }
    } else {
      stopSpinner()
      statusBar.text = '🐳\uFE0E DSH'
      statusBar.backgroundColor = undefined
      statusBar.color = undefined
      statusBar.tooltip = 'DeepSeek Harness stopped — click to start & open'
    }
  }

  void refreshStatusBar().catch(() => {})
  const statusTimer = setInterval(() => void refreshStatusBar().catch(() => {}), STATUS_REFRESH_INTERVAL_MS)

  context.subscriptions.push(
    statusBar,
    { dispose: () => { clearInterval(statusTimer); stopSpinner() } },
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
