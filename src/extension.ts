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
const RUNNING_BACKGROUND_COLOR = 'dsh.statusBar.runningBackground'
const RUNNING_FOREGROUND_COLOR = 'dsh.statusBar.runningForeground'
const STATUS_TEXT = '$(dsh-whale)'
const STATUS_SPLASH_SMALL = '$(dsh-whale-splash-small)'
const STATUS_SPLASH_LARGE = '$(dsh-whale-splash-large)'

type InstanceAction = 'start' | 'stop' | 'restart' | 'open' | 'select'

type MenuPick = vscode.QuickPickItem & {
  action?: StatusMenuAction
  instanceId?: string
  instanceAction?: InstanceAction
}

function instanceIdArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function instanceStateLabel(status: InstanceRuntimeStatus): string {
  if (status.adopted) return 'running (external)'
  if (status.untrackedPort) return 'port held by an untracked process'
  return status.state
}

function instanceStateIcon(status: InstanceRuntimeStatus): string {
  if (status.adopted || status.untrackedPort) return 'warning'
  if (status.state === 'running') return 'globe'
  if (status.state === 'starting' || status.installing) return 'sync~spin'
  if (status.state === 'stopping') return 'sync'
  if (status.state === 'error') return 'error'
  return 'circle-outline'
}

function menuItem(
  status: InstanceRuntimeStatus,
  label: string,
  icon: string,
  instanceAction: InstanceAction,
  description?: string,
): MenuPick {
  return { label, description, iconPath: new vscode.ThemeIcon(icon), instanceId: status.id, instanceAction }
}

function instanceRow(instance: InstanceRuntimeStatus, activeId: string): MenuPick {
  return {
    label: instance.name,
    description: `:${instance.port} · ${instanceStateLabel(instance)}${instance.id === activeId ? ' · active' : ''}`,
    detail: instance.homeShort,
    iconPath: new vscode.ThemeIcon(instanceStateIcon(instance)),
    instanceId: instance.id,
  }
}

/** Rows carry the instance id so an action never depends on which tab is active. */
function instanceMenuItems(status: InstanceRuntimeStatus, activeId: string): MenuPick[] {
  const items: MenuPick[] = []
  if (status.running) items.push(menuItem(status, `Open ${status.name} Web UI`, 'globe', 'open'))
  if (status.state !== 'stopping') {
    if (status.running) {
      items.push(menuItem(status, `Restart ${status.name}`, 'debug-restart', 'restart'))
    } else {
      items.push(menuItem(status, `Start ${status.name}`, 'play', 'start', status.state === 'error' ? 'retry after the failure' : undefined))
    }
    if (status.running || status.starting || status.adopted || status.untrackedPort) {
      items.push(menuItem(status, `Stop ${status.name}`, 'debug-stop', 'stop'))
    }
  }
  if (status.id !== activeId) items.push(menuItem(status, `Make ${status.name} Active`, 'star', 'select'))
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

  // External settings edits reach this manager; reloading reuses running runtimes.
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

  const setStatusBar = (text: string, tooltip: string, running = false): void => {
    stopSpinner()
    statusBar.text = text
    statusBar.backgroundColor = running ? new vscode.ThemeColor(RUNNING_BACKGROUND_COLOR) : undefined
    statusBar.color = running ? new vscode.ThemeColor(RUNNING_FOREGROUND_COLOR) : undefined
    statusBar.tooltip = tooltip
  }

  const refreshStatusBar = async (): Promise<void> => {
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
        statusBar.text = statusBar.text === STATUS_SPLASH_SMALL ? STATUS_SPLASH_LARGE : STATUS_SPLASH_SMALL
      }, STATUS_SPIN_INTERVAL_MS)
    } else {
      setStatusBar(STATUS_TEXT, `${label} ${status.stopping ? 'stopping' : 'stopped'}${suffix}`)
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

  const command = (id: string, run: (instanceId?: string) => Promise<void>, refresh = false) =>
    vscode.commands.registerCommand(id, async (value?: unknown) => {
      await run(instanceIdArg(value))
      if (refresh) void refreshStatusBar().catch(() => {})
    })

  context.subscriptions.push(
    statusBar,
    { dispose: () => { clearInterval(statusTimer); stopSpinner() } },
    vscode.commands.registerCommand('dsh.statusMenu', async () => {
      const dashboard = await manager.dashboard()
      const active = dashboard.active
      const items: MenuPick[] = [
        { label: buildStatusMenuSummary(dashboard.status, active?.name), kind: vscode.QuickPickItemKind.Separator },
      ]
      if (dashboard.instances.length > 0) {
        items.push({ label: dashboard.instances.length > 1 ? 'Instances' : 'Instance', kind: vscode.QuickPickItemKind.Separator })
        for (const instance of dashboard.instances) items.push(instanceRow(instance, dashboard.activeId))
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
    command('dsh.start', () => actionStart(), true),
    command('dsh.stop', () => actionStop(), true),
    command('dsh.instance.start', (id) => actionStart(id), true),
    command('dsh.instance.stop', (id) => actionStop(id), true),
    command('dsh.instance.restart', (id) => actionRestart(id), true),
    command('dsh.instance.new', () => actionCreateInstance()),
    command('dsh.instance.edit', (id) => actionEditInstance(id)),
    command('dsh.instance.delete', (id) => actionDeleteInstance(id)),
    command('dsh.instance.select', () => actionSelectInstance()),
    command('dsh.instance.open', (id) => actionOpen(id)),
  )
}

export function deactivate(): void {
  getInstanceManager()?.dispose()
}
