import * as vscode from 'vscode'
import {
  actionDeleteInstance,
  actionSetBrowser,
  actionStart,
  actionStop,
  actionUpdateDsh,
  defaultInstanceHome,
  defaultInstanceHomePrefix,
  openUrl,
} from '../actions.ts'
import { getInstanceManager, type InstanceManager } from '../instances/manager.ts'
import { describeDshUpdate } from '../dsh/versions.ts'
import { addActivity, dbg, withBusy } from '../shared/activity.ts'
import { writeRunMode } from '../dsh/config.ts'
import { fetchDshBalance, getDshBalance } from './deepseek.ts'
import { parseInstanceFormPayload } from './form.ts'
import {
  isBrowserChoice,
  PANEL_COMMANDS,
  PANEL_MESSAGE_TYPES,
  type PanelHostMessage,
  type PanelInstanceForm,
  type PanelMessage,
} from './webview/panel-contract.ts'

const STATUS_URL = 'https://status.deepseek.com/'
const SETTINGS_QUERY = '@ext:peiyucn.dsh-launcher-panel'
const NOT_READY = 'Launcher is not ready yet — try again in a moment'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The provider services a message handler needs; kept small so the split has one seam. */
export interface PanelMessageHost {
  hasView(): boolean
  busy(): boolean
  post(message: PanelHostMessage): void
  requestRefresh(): Promise<void>
}

export class PanelMessages {
  constructor(private readonly host: PanelMessageHost) {}

  handleRaw(raw: unknown): void {
    // Escaping this handler would become an unhandled rejection in VS Code.
    if (typeof raw !== 'object' || raw === null) {
      dbg(`ignored non-object webview message: ${String(raw)}`)
      return
    }
    const message = raw as PanelMessage
    dbg(`message from webview: ${JSON.stringify(message)}`)
    if (message.command === PANEL_COMMANDS.ready) {
      // The initial refresh may still be in flight and posts after the webview
      // listens; when it already finished, ask for a fresh snapshot instead.
      if (!this.host.busy()) void this.host.requestRefresh()
      return
    }
    void this.handle(message)
  }

  private async handle(message: PanelMessage): Promise<void> {
    const command = typeof message.command === 'string' ? message.command : '(unknown)'
    try {
      await this.dispatch(message)
    } catch (error) {
      const msg = errorMessage(error)
      dbg(`webview command "${command}" failed: ${msg}`)
      addActivity(`✗ Command failed (${command}): ${msg}`)
    }
    // Every command ends in the single-flight refresh; no handler refreshes.
    await this.host.requestRefresh()
  }

  private async dispatch(message: PanelMessage): Promise<void> {
    const manager = getInstanceManager()
    switch (message.command) {
      case 'start': return actionStart(message.value)
      case 'stop': return actionStop(message.value)
      case 'instanceForm': return this.openInstanceForm(message.value ?? 'new')
      case 'saveInstanceForm': return this.saveInstanceForm(message.value)
      case 'selectInstance':
        if (manager && message.value) await manager.select(message.value)
        return
      case 'deleteInstance': return actionDeleteInstance(message.value)
      case 'updateDsh': return this.updateDsh()
      case 'refreshRequirements': return this.refreshRequirements(manager)
      case 'setMode': return this.setMode(manager, message.value)
      case 'revealPath':
        if (message.value) void vscode.env.openExternal(vscode.Uri.file(message.value))
        return
      case 'openLog': return this.openLog(message.value)
      case 'balance': return this.queryBalance(manager)
      case 'setBrowser':
        if (isBrowserChoice(message.value)) return actionSetBrowser(message.value)
        dbg(`ignored setBrowser with invalid value: ${JSON.stringify(message.value)}`)
        return
      case 'openStatus': return openUrl(STATUS_URL)
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', SETTINGS_QUERY)
        return
      case 'toggleDebug': return this.toggleDebug()
      case 'clearConsole': {
        const id = manager?.activeInstance()?.id
        if (manager && id) manager.clearConsole(id)
        return
      }
      default:
        dbg(`ignored unknown webview command: ${JSON.stringify(message.command)}`)
    }
  }

  private async updateDsh(): Promise<void> {
    try {
      await actionUpdateDsh()
    } catch (error) {
      void vscode.window.showErrorMessage(`DSH update failed: ${errorMessage(error)}`)
    }
  }

  private async refreshRequirements(manager: InstanceManager | undefined): Promise<void> {
    addActivity(describeDshUpdate(await manager?.checkUpdate(true)))
  }

  private async setMode(manager: InstanceManager | undefined, value: string | undefined): Promise<void> {
    if (value !== 'pnpm' && value !== 'source') {
      dbg(`ignored setMode with invalid value: ${JSON.stringify(value)}`)
      return
    }
    if (manager?.anyActive()) {
      void vscode.window.showWarningMessage('Stop all DSH instances before switching run mode.')
      return
    }
    await writeRunMode(value)
    manager?.invalidateDetection()
  }

  private async openLog(file: string | undefined): Promise<void> {
    if (!file) return
    const uri = vscode.Uri.file(file)
    try {
      await vscode.window.showTextDocument(uri, { preview: true })
    } catch {
      void vscode.env.openExternal(uri)
    }
  }

  private async queryBalance(manager: InstanceManager | undefined): Promise<void> {
    await withBusy('↻ Querying DeepSeek balance…', async () => {
      const home = manager?.activeInstance()?.home
      await fetchDshBalance(home || undefined)
      const b = getDshBalance(home || undefined)
      if (b?.balance) addActivity(`✓ Balance: ${b.balance.total} ${b.balance.currency}`)
      else addActivity(`⚠ Balance: ${b?.error ?? 'no balance data'}`)
    })
  }

  private async toggleDebug(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('dsh')
    await cfg.update('sourceDebug', !(cfg.get<boolean>('sourceDebug') ?? false), vscode.ConfigurationTarget.Global)
  }

  private postInstanceFormError(message: string): void {
    this.host.post({ type: PANEL_MESSAGE_TYPES.instanceFormError, message })
  }

  private postInstanceForm(form: PanelInstanceForm): void {
    this.host.post({ type: PANEL_MESSAGE_TYPES.instanceForm, form })
  }

  private async openInstanceForm(value: string): Promise<void> {
    const manager = getInstanceManager()
    if (!manager) return this.postInstanceFormError(NOT_READY)
    if (!this.host.hasView()) return
    // Prefill from the same list the save validates against.
    await manager.ready().catch(() => {})
    if (value === 'new') {
      const name = `Instance ${manager.instances().length + 1}`
      return this.postInstanceForm({ mode: 'new', name, home: defaultInstanceHome(name), homePrefix: defaultInstanceHomePrefix() })
    }
    const instance = manager.instance(value)
    if (!instance) return this.postInstanceFormError('Instance was not found')
    this.postInstanceForm({
      mode: 'edit',
      id: instance.id,
      name: instance.name,
      home: manager.homeOf(instance),
      homePrefix: defaultInstanceHomePrefix(),
      autoOpenBrowser: instance.autoOpenBrowser,
      browser: instance.browser,
    })
  }

  private async saveInstanceForm(value: string | undefined): Promise<void> {
    const manager = getInstanceManager()
    if (!manager) return this.postInstanceFormError(NOT_READY)
    // Waiting for the bootstrap keeps validation consistent with the prefill.
    await manager.ready().catch(() => {})
    const parsed = parseInstanceFormPayload(value)
    if (!parsed.ok) return this.postInstanceFormError(parsed.message)
    const form = parsed.form
    const editing = form.mode === 'edit'
    let port: number | undefined
    let profile = 'web'
    if (editing) {
      const current = form.id ? manager.instance(form.id) : undefined
      if (!current) return this.postInstanceFormError('Instance was not found')
      port = current.port
      profile = current.profile
    } else {
      port = await manager.suggestPort()
      if (port === undefined) return this.postInstanceFormError('No free Web UI port was found for the new instance')
    }
    const input = { name: form.name, home: form.home, profile, port, autoOpenBrowser: form.autoOpenBrowser, browser: form.browser }
    const mutation = editing ? manager.update(form.id, input) : manager.create(input)
    const result = await mutation.catch((error) => {
      this.postInstanceFormError(errorMessage(error))
      return undefined
    })
    if (!result) return
    const error = result.issues.find((issue) => issue.severity === 'error')
    if (!result.instance || error) return this.postInstanceFormError(error?.message ?? 'Instance was not saved')
    this.host.post({ type: PANEL_MESSAGE_TYPES.instanceFormSaved })
  }
}
