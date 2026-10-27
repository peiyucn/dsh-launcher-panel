import * as vscode from 'vscode'
import { webcrypto } from 'node:crypto'
import {
  actionDeleteInstance,
  actionSetBrowser,
  actionStart,
  actionStop,
  actionUpdateDsh,
  defaultInstanceHome,
  defaultInstanceHomePrefix,
  openUrl,
} from '../app/actions.ts'
import { DEFAULT_BROWSER, NONCE_LENGTH, normalizeBrowser } from '../shared/env.ts'
import { fetchDshBalance, getDshBalance, getDsStatus, hasDeepSeekModel } from './deepseek.ts'
import { getInstanceManager, type InstanceManager } from '../instances/manager.ts'
import { parseInstanceFormPayload } from './form.ts'
import { PEAK_WINDOWS_BJ_HOURS, pricingWindowAt } from './pricing.ts'
import { describeDshUpdate } from '../dsh/versions.ts'
import { PANEL_REFRESH_INTERVAL_MS } from '../shared/timing.ts'
import { addActivity, clearConsole, dbg, getActivity, withBusy } from '../shared/activity.ts'
import { writeRunMode } from '../dsh/config.ts'
import {
  buildPanelUpdate,
  isBrowserChoice,
  PANEL_COMMANDS,
  PANEL_MESSAGE_TYPES,
  type PanelHostMessage,
  type PanelInstanceForm,
  type PanelMessage,
  type PanelStatus,
  type PanelUpdate,
} from './webview/panel-contract.ts'
import { createRefreshScheduler } from './webview/panel-refresh.ts'
import { PANEL_CSS } from './webview/panel-styles.ts'
import { panelBody } from './webview/panel-body.ts'
import { panelScript } from './webview/panel-script.ts'

const STATUS_URL = 'https://status.deepseek.com/'
const SETTINGS_QUERY = '@ext:peiyucn.dsh-launcher-panel'
const NOT_READY = 'Launcher is not ready yet — try again in a moment'

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(NONCE_LENGTH)
  webcrypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < NONCE_LENGTH; i++) out += chars.charAt(bytes[i] % chars.length)
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const IDLE_STATUS: PanelStatus = {
  running: false, starting: false, installing: false, stopping: false, checking: false, updating: false,
  url: '', dsh: 'unknown', dshVersion: '', dshPath: '', dshHome: '', dshPathShort: '', dshHomeShort: '',
  nodeVersion: '', mode: 'pnpm', update: undefined, consoleLogPath: '', consoleLogPathShort: '',
  serverLogPath: '', serverLogPathShort: '', consoleLogSize: 0, serverLogSize: 0, sourceDebug: false,
}

function emptyStatus(): PanelStatus {
  const cfg = vscode.workspace.getConfiguration('dsh')
  return {
    ...IDLE_STATUS,
    mode: cfg.get<string>('runMode') === 'source' ? 'source' : 'pnpm',
    sourceDebug: cfg.get<boolean>('sourceDebug') ?? false,
  }
}

export class DshPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dsh.panel'

  private view: vscode.WebviewView | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private lastUpdate: PanelUpdate | undefined
  private readonly refresher = createRefreshScheduler(() => this.refreshOnce())

  constructor(private readonly version: string) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    dbg(`view resolved, visible=${view.visible}`)
    view.webview.options = { enableScripts: true }
    view.webview.html = this.getHtml()
    view.webview.onDidReceiveMessage((message: unknown) => {
      // Escaping this handler would become an unhandled rejection in VS Code.
      if (typeof message !== 'object' || message === null) {
        dbg(`ignored non-object webview message: ${String(message)}`)
        return
      }
      const msg = message as PanelMessage
      dbg(`message from webview: ${JSON.stringify(msg)}`)
      if (msg.command === PANEL_COMMANDS.ready) {
        // The initial refresh may still be in flight and posts after the webview
        // listens; when it already finished, ask for a fresh snapshot instead.
        if (!this.refresher.busy) void this.requestRefresh()
        return
      }
      void this.onMessage(msg)
    })
    view.onDidChangeVisibility(() => {
      dbg(`visibility changed, visible=${view.visible}`)
      if (view.visible) {
        this.startTimer()
        void this.requestRefresh()
      } else {
        this.stopTimer()
      }
    })
    view.onDidDispose(() => {
      this.stopTimer()
      this.view = undefined
    })
    if (view.visible) this.startTimer()
    void this.requestRefresh()
  }

  private getHtml(): string {
    const nonce = getNonce()
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${PANEL_CSS}
</style>
</head>
<body>
${panelBody({ version: this.version })}
  <script nonce="${nonce}">
${panelScript({ peakWindows: JSON.stringify(PEAK_WINDOWS_BJ_HOURS), defaultBrowser: DEFAULT_BROWSER })}
  </script>
</body>
</html>`
  }

  private async onMessage(message: PanelMessage): Promise<void> {
    const command = typeof message.command === 'string' ? message.command : '(unknown)'
    try {
      await this.handleMessage(message)
    } catch (error) {
      const msg = errorMessage(error)
      dbg(`webview command "${command}" failed: ${msg}`)
      addActivity(`✗ Command failed (${command}): ${msg}`)
    }
    // Every command ends in the single-flight refresh; no handler refreshes.
    await this.requestRefresh()
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
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
      case 'clearConsole':
        if (manager) manager.clearConsole(manager.activeInstance()?.id ?? '')
        clearConsole()
        return
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

  private postToWebview(message: PanelHostMessage): void {
    void this.view?.webview.postMessage(message)
  }

  private postInstanceFormError(message: string): void {
    this.postToWebview({ type: PANEL_MESSAGE_TYPES.instanceFormError, message })
  }

  private postInstanceForm(form: PanelInstanceForm): void {
    this.postToWebview({ type: PANEL_MESSAGE_TYPES.instanceForm, form })
  }

  private async openInstanceForm(value: string): Promise<void> {
    const manager = getInstanceManager()
    if (!manager) return this.postInstanceFormError(NOT_READY)
    if (!this.view) return
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
    this.postToWebview({ type: PANEL_MESSAGE_TYPES.instanceFormSaved })
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => void this.requestRefresh(), PANEL_REFRESH_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  requestRefresh(): Promise<void> {
    return this.refresher.request()
  }

  private browserChoice(): 'built-in' | 'external' {
    return normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser'))
  }

  private async refreshOnce(): Promise<void> {
    const view = this.view
    if (!view) {
      dbg('refresh skipped (no view)')
      return
    }
    try {
      const manager = getInstanceManager()
      if (!manager) {
        await view.webview.postMessage(buildPanelUpdate({ status: emptyStatus(), browser: this.browserChoice(), pricing: pricingWindowAt(new Date()) }))
        return
      }
      const dashboard = await manager.dashboard()
      const home = dashboard.active?.home
      const showDs = home ? hasDeepSeekModel(home) : hasDeepSeekModel()
      this.lastUpdate = buildPanelUpdate({
        status: dashboard.status,
        instances: dashboard.instances,
        active: dashboard.active,
        activeId: dashboard.activeId,
        issues: dashboard.issues,
        activity: manager.activityFor(dashboard.activeId),
        browser: this.browserChoice(),
        dsStatus: showDs ? await getDsStatus() : undefined,
        balance: showDs ? getDshBalance(home) : undefined,
        showDs,
        pricing: pricingWindowAt(new Date()),
      })
      await view.webview.postMessage(this.lastUpdate)
    } catch (error) {
      console.error('[dsh-launcher-panel] refresh failed:', error)
      await this.postRefreshFailure(view, errorMessage(error))
    }
  }

  // Reuse the last good snapshot: a fresh empty one would claim the server
  // stopped and hide active/showDs, disabling Start while instances exist.
  private async postRefreshFailure(view: vscode.WebviewView, reason: string): Promise<void> {
    try {
      const manager = getInstanceManager()
      const previous = this.lastUpdate
      const status: PanelStatus = previous
        ? { ...previous.status, unknown: true, running: false, starting: false, installing: false, stopping: false, checking: false, updating: false, url: '' }
        : { ...emptyStatus(), unknown: true }
      const fresh = manager?.instanceStatuses() ?? []
      const activeId = manager?.activeInstanceId() || previous?.activeId || ''
      const active = manager ? (manager.statusOf(activeId) ?? previous?.active) : previous?.active
      const home = active?.home
      await view.webview.postMessage(buildPanelUpdate({
        status,
        instances: fresh.length > 0 ? fresh : (previous?.instances ?? []),
        active,
        activeId,
        issues: [...(manager?.issues() ?? []), { index: -1, field: 'entry', severity: 'error', message: `Status refresh failed: ${reason}` }],
        activity: getActivity().concat([{ id: -1, text: `✗ Status refresh failed: ${reason}`, busy: false }]),
        browser: this.browserChoice(),
        dsStatus: previous?.dsStatus,
        balance: previous?.balance,
        showDs: previous?.showDs ?? (home ? hasDeepSeekModel(home) : false),
        pricing: pricingWindowAt(new Date()),
      }))
    } catch {
      // The webview is gone; the next tick gets a fresh chance.
    }
  }
}
