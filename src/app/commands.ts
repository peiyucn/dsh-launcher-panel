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
} from '../actions.ts'
import type { InstanceManager } from '../instances/manager.ts'
import type { InstanceRuntimeStatus } from '../instances/runtime/runtime.ts'
import { buildStatusMenuItems, buildStatusMenuSummary, type StatusMenuAction } from './status-menu.ts'
import type { StatusBar } from './status-bar.ts'

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

// Rows carry the instance id so an action never depends on which tab is active.
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

export function registerCommands(context: vscode.ExtensionContext, manager: InstanceManager, statusBar: StatusBar): void {
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
    void statusBar.refresh().catch(() => {})
  }

  const command = (id: string, run: (instanceId?: string) => Promise<void>, refresh = false) =>
    vscode.commands.registerCommand(id, async (value?: unknown) => {
      await run(instanceIdArg(value))
      if (refresh) void statusBar.refresh().catch(() => {})
    })

  context.subscriptions.push(
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
        void statusBar.refresh().catch(() => {})
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
