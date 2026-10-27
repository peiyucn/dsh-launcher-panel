import * as path from 'node:path'
import * as vscode from 'vscode'
import { DshPanelProvider } from './panel/panel.ts'
import { getInstanceManager, InstanceManager, setInstanceManager } from './instances/manager.ts'
import { dshBaseDir } from './dsh/paths.ts'
import { dbg, setLogPath } from './shared/activity.ts'
import { migrateLegacyDshConfig } from './dsh/config.ts'
import { createStatusBar } from './app/status-bar.ts'
import { registerCommands } from './app/commands.ts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function activate(context: vscode.ExtensionContext): void {
  setLogPath(path.join(dshBaseDir(), 'logs', 'client.log'))
  dbg('activated')
  void migrateLegacyDshConfig()

  const manager = new InstanceManager(context)
  setInstanceManager(manager)
  void manager.ready().then(() => manager.refresh()).catch((error) => {
    dbg(`manager initialization failed: ${errorText(error)}`)
  })

  // External settings edits reach this manager; reloading reuses running runtimes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dsh.instances') && !event.affectsConfiguration('dsh.activeInstance')) return
      void manager.reloadSettings().catch((error) => {
        dbg(`instance settings reload failed: ${errorText(error)}`)
      })
    }),
  )

  const panelProvider = new DshPanelProvider(context.extension.packageJSON.version ?? '0.0.0')
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  const statusBar = createStatusBar(manager)
  context.subscriptions.push(statusBar)
  registerCommands(context, manager, statusBar)
}

export function deactivate(): void {
  getInstanceManager()?.dispose()
}
