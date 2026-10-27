import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  actionCreateInstance,
  actionDeleteInstance,
  actionEditInstance,
  actionOpen,
  actionRestart,
  actionSelectInstance,
  actionStart,
  actionStop,
} from './actions.ts'
import { DshPanelProvider } from './panel.ts'
import { getInstanceManager, InstanceManager, setInstanceManager } from './instance-manager.ts'
import type { InstanceRuntimeStatus } from './server/instance-runtime.ts'
import { dshBaseDir } from './paths.ts'
import { STATUS_BAR_REFRESH_INTERVAL_MS } from './timing.ts'
import { dbg, setLogPath } from './server/activity.ts'
import { migrateLegacyDshConfig } from './server/config.ts'
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

/** Per-instance actions offered after picking an instance row. */
type InstanceAction = 'start' | 'stop' | 'restart' | 'open' | 'select'

/** A quick-pick row; action rows carry either a global or an instance action. */
type MenuPick = vscode.QuickPickItem & {
  action?: StatusMenuAction
  instanceId?: string
  instanceAction?: InstanceAction
}

/** A command argument that should be an instance id (command palette passes none). */
function instanceIdArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The state word shown for one instance, including adopted/untracked servers. */
function instanceStateLabel(status: InstanceRuntimeStatus): string {
  if (status.adopted) return 'running (external)'
  if (status.untrackedPort) return 'port held by an untracked process'
  return status.state
}

/** Codicon for one instance row. */
function instanceStateIcon(status: InstanceRuntimeStatus): string {
  if (status.adopted || status.untrackedPort) return 'warning'
  if (status.state === 'running') return 'globe'
  if (status.state === 'starting' || status.installing) return 'sync~spin'
  if (status.state === 'stopping') return 'sync'
  if (status.state === 'error') return 'error'
  return 'circle-outline'
}

/**
 * The actions that make sense for one instance's current state.
 *
 * Every row carries the instance id, so the action never depends on which tab
 * happens to be active (spec §9: panel buttons must not rely on implicit state).
 */
function instanceMenuItems(status: InstanceRuntimeStatus, activeId: string): MenuPick[] {
  const items: MenuPick[] = []
  if (status.running) {
    items.push({
      label: `Open ${status.name} Web UI`,
      iconPath: new vscode.ThemeIcon('globe'),
      instanceId: status.id,
      instanceAction: 'open',
    })
  }
  if (status.state !== 'stopping') {
    if (!status.running) {
      items.push({
        label: `Start ${status.name}`,
        description: status.state === 'error' ? 'retry after the failure' : undefined,
        iconPath: new vscode.ThemeIcon('play'),
        instanceId: status.id,
        instanceAction: 'start',
      })
    } else {
      items.push({
        label: `Restart ${status.name}`,
        iconPath: new vscode.ThemeIcon('debug-restart'),
        instanceId: status.id,
        instanceAction: 'restart',
      })
    }
    if (status.running || status.starting || status.adopted || status.untrackedPort) {
      items.push({
        label: `Stop ${status.name}`,
        iconPath: new vscode.ThemeIcon('debug-stop'),
        instanceId: status.id,
        instanceAction: 'stop',
      })
    }
  }
  if (status.id !== activeId) {
    items.push({
      label: `Make ${status.name} Active`,
      iconPath: new vscode.ThemeIcon('star'),
      instanceId: status.id,
      instanceAction: 'select',
    })
  }
  return items
}

export function activate(context: vscode.ExtensionContext): void {
  setLogPath(path.join(dshBaseDir(), 'logs', 'client.log'))
  dbg('activated')
  void migrateLegacyDshConfig()

  const manager = new InstanceManager(context)
  setInstanceManager(manager)
  void manager.ready().then(() => manager.refresh()).catch((error) => {
    dbg(`manager initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Settings edits from another window, the Settings UI or settings sync must
  // reach this manager; reloading reuses running runtimes by id (never rebuilds
  // them), so a tracked DSH child is not orphaned. See InstanceManager.reloadSettings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dsh.instances') && !event.affectsConfiguration('dsh.activeInstance')) return
      void manager.reloadSettings().catch((error) => {
        dbg(`instance settings reload failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }),
  )

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

  /** Run one instance-scoped action, then repaint the status bar. */
  const runInstanceAction = async (id: string, action: InstanceAction): Promise<void> => {
    switch (action) {
      case 'start':
        await actionStart(id)
        break
      case 'stop':
        await actionStop(id)
        break
      case 'restart':
        await actionRestart(id)
        break
      case 'open':
        await actionOpen(id)
        break
      case 'select':
        await manager.select(id)
        break
    }
    void refreshStatusBar().catch(() => {})
  }

  context.subscriptions.push(
    statusBar,
    { dispose: () => { clearInterval(statusTimer); stopSpinner() } },
    vscode.commands.registerCommand('dsh.statusMenu', async () => {
      const dashboard = await manager.dashboard()
      const active = dashboard.active
      const items: MenuPick[] = [
        { label: buildStatusMenuSummary(dashboard.status, active?.name), kind: vscode.QuickPickItemKind.Separator },
      ]
      // Every instance is selectable, not just the running ones (spec §9): the
      // menu is also how a stopped instance gets started without the panel.
      if (dashboard.instances.length > 0) {
        items.push({ label: dashboard.instances.length > 1 ? 'Instances' : 'Instance', kind: vscode.QuickPickItemKind.Separator })
        for (const instance of dashboard.instances) {
          items.push({
            label: instance.name,
            description: `:${instance.port} · ${instanceStateLabel(instance)}${instance.id === dashboard.activeId ? ' · active' : ''}`,
            detail: instance.homeShort,
            iconPath: new vscode.ThemeIcon(instanceStateIcon(instance)),
            instanceId: instance.id,
          })
        }
        items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator })
      }
      items.push(...buildStatusMenuItems(dashboard.status, active?.name).map((item) => ({
        label: item.label,
        iconPath: new vscode.ThemeIcon(item.icon),
        action: item.action,
      })))
      const picked = await vscode.window.showQuickPick(items, {
        title: 'DSH Launcher Panel',
        placeHolder: active?.name ? `${active.name} — choose an instance or an action` : 'Choose an instance or an action',
      })
      if (!picked) return
      if (picked.instanceId !== undefined && picked.instanceAction !== undefined) {
        await runInstanceAction(picked.instanceId, picked.instanceAction)
        return
      }
      if (picked.instanceId !== undefined) {
        const instance = dashboard.instances.find((entry) => entry.id === picked.instanceId)
        if (!instance) return
        const actions = instanceMenuItems(instance, dashboard.activeId)
        if (actions.length === 0) {
          void vscode.window.showInformationMessage(`"${instance.name}" has no action right now.`)
          return
        }
        const actionPick = await vscode.window.showQuickPick(actions, {
          title: instance.name,
          placeHolder: `${instanceStateLabel(instance)} — choose an action`,
        })
        if (actionPick?.instanceAction) await runInstanceAction(instance.id, actionPick.instanceAction)
        return
      }
      if (picked.action) {
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
    vscode.commands.registerCommand('dsh.instance.start', async (id?: unknown) => {
      await actionStart(instanceIdArg(id))
      void refreshStatusBar().catch(() => {})
    }),
    vscode.commands.registerCommand('dsh.instance.stop', async (id?: unknown) => {
      await actionStop(instanceIdArg(id))
      void refreshStatusBar().catch(() => {})
    }),
    vscode.commands.registerCommand('dsh.instance.restart', async (id?: unknown) => {
      await actionRestart(instanceIdArg(id))
      void refreshStatusBar().catch(() => {})
    }),
    vscode.commands.registerCommand('dsh.instance.new', () => actionCreateInstance()),
    vscode.commands.registerCommand('dsh.instance.edit', (id?: unknown) => actionEditInstance(instanceIdArg(id))),
    vscode.commands.registerCommand('dsh.instance.delete', (id?: unknown) => actionDeleteInstance(instanceIdArg(id))),
    vscode.commands.registerCommand('dsh.instance.select', () => actionSelectInstance()),
    vscode.commands.registerCommand('dsh.instance.open', (id?: unknown) => actionOpen(instanceIdArg(id))),
  )
}

export function deactivate(): void {
  // The servers are intentionally left running; Stop them from the panel or the
  // DSH Launcher Panel: Stop command. Log pumps belong to this host and stop with
  // it; each server keeps writing its own log file regardless.
  getInstanceManager()?.dispose()
}
