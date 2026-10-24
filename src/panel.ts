import * as vscode from 'vscode'
import { webcrypto } from 'node:crypto'
import {
  actionCreateInstance,
  actionDeleteInstance,
  actionEditInstance,
  actionSetBrowser,
  actionStart,
  actionStop,
  actionUpdateDsh,
  defaultInstanceHome,
  defaultInstanceHomePrefix,
  openUrl,
} from './actions.ts'
import { DEFAULT_BROWSER, NONCE_LENGTH, normalizeBrowser } from './env.ts'
import { getInstanceManager } from './instance-manager.ts'
import { PEAK_WINDOWS_BJ_HOURS, pricingWindowAt } from './pricing.ts'
import { describeDshUpdate } from './versions.ts'
import { STATUS_REFRESH_INTERVAL_MS } from './timing.ts'
import {
  addActivity,
  applyMode,
  clearConsole,
  dbg,
  fetchDshBalance,
  getActivity,
  getDshBalance,
  getDsStatus,
  hasDeepSeekModel,
  withBusy,
} from './server.ts'
import { PANEL_CSS } from './webview/panel-styles.ts'
import { panelBody } from './webview/panel-body.ts'
import { panelScript } from './webview/panel-script.ts'

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(NONCE_LENGTH)
  webcrypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < NONCE_LENGTH; i++) out += chars.charAt(bytes[i] % chars.length)
  return out
}

/** The status shape used before the manager exists or when a refresh throws. */
function emptyStatus() {
  const cfg = vscode.workspace.getConfiguration('dsh')
  return {
    running: false,
    starting: false,
    installing: false,
    stopping: false,
    checking: false,
    updating: false,
    url: '',
    dsh: 'unknown' as const,
    dshVersion: '',
    dshPath: '',
    dshHome: '',
    dshPathShort: '',
    dshHomeShort: '',
    nodeVersion: '',
    mode: cfg.get<string>('runMode') === 'source' ? 'source' as const : 'pnpm' as const,
    update: undefined,
    consoleLogPath: '',
    consoleLogPathShort: '',
    serverLogPath: '',
    serverLogPathShort: '',
    consoleLogSize: 0,
    serverLogSize: 0,
    sourceDebug: cfg.get<boolean>('sourceDebug') ?? false,
  }
}

export class DshPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dsh.panel'

  private view: vscode.WebviewView | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly version: string) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    dbg(`view resolved, visible=${view.visible}`)
    view.webview.options = { enableScripts: true }
    view.webview.html = this.getHtml()
    view.webview.onDidReceiveMessage((message: { command?: string; value?: string }) => {
      dbg(`message from webview: ${JSON.stringify(message)}`)
      if (message && message.command === 'ready') {
        void this.refresh()
        return
      }
      void this.onMessage(message)
    })
    view.onDidChangeVisibility(() => {
      dbg(`visibility changed, visible=${view.visible}`)
      if (view.visible) this.startTimer()
      else this.stopTimer()
    })
    view.onDidDispose(() => this.stopTimer())
    if (view.visible) this.startTimer()
    void this.refresh()
  }

  /**
   * Compose the dashboard document. The three regions live in `webview/`
   * (markup, styles, client script) so each can be read and reviewed on its
   * own; this method only assembles them and supplies the CSP nonce.
   */
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

  /**
   * Webview message entry point. A failing command must never escape into
   * VS Code's message pipeline (an unhandled rejection there is invisible), and
   * the trailing refresh has to happen even then — otherwise one bad click
   * freezes the dashboard on stale data.
   */
  private async onMessage(message: { command?: string; value?: string }): Promise<void> {
    try {
      await this.handleMessage(message)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      dbg(`webview command "${message.command}" failed: ${msg}`)
      addActivity(`✗ Command failed (${message.command}): ${msg}`)
    }
    await this.refresh()
  }

  private async handleMessage(message: { command?: string; value?: string }): Promise<void> {
    const manager = getInstanceManager()
    switch (message.command) {
      case 'start':
        await actionStart(message.value)
        break
      case 'stop':
        await actionStop(message.value)
        break
      case 'newInstance':
        await actionCreateInstance()
        break
      case 'instanceForm':
        await this.openInstanceForm(message.value ?? 'new')
        break
      case 'saveInstanceForm':
        await this.saveInstanceForm(message.value)
        break
      case 'selectInstance':
        if (manager && message.value) await manager.select(message.value)
        break
      case 'editInstance':
        await actionEditInstance(message.value)
        break
      case 'deleteInstance':
        await actionDeleteInstance(message.value)
        break
      case 'updateDsh':
        try {
          await actionUpdateDsh()
        } catch (error) {
          void vscode.window.showErrorMessage(`DSH update failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        break
      case 'refreshRequirements': {
        const update = await manager?.checkUpdate(true)
        addActivity(describeDshUpdate(update))
        await manager?.refresh()
        break
      }
      case 'setMode':
        if (message.value === 'pnpm' || message.value === 'source') {
          if (manager?.anyActive()) {
            void vscode.window.showWarningMessage('Stop all DSH instances before switching run mode.')
            break
          }
          await applyMode(message.value)
          manager?.invalidateDetection()
          await manager?.refresh()
        }
        break
      case 'revealPath':
        if (message.value) void vscode.env.openExternal(vscode.Uri.file(message.value))
        break
      case 'openLog':
        if (message.value) {
          const uri = vscode.Uri.file(message.value)
          try {
            await vscode.window.showTextDocument(uri, { preview: true })
          } catch {
            void vscode.env.openExternal(uri)
          }
        }
        break
      case 'balance':
        await withBusy('↻ Querying DeepSeek balance…', async () => {
          const home = manager?.activeInstance()?.home
          await fetchDshBalance(home || undefined)
          const b = getDshBalance(home || undefined)
          if (b?.balance) addActivity(`✓ Balance: ${b.balance.total} ${b.balance.currency}`)
          else addActivity(`⚠ Balance: ${b?.error ?? 'no balance data'}`)
        })
        break
      case 'setBrowser':
        if (message.value) await actionSetBrowser(message.value)
        break
      case 'openStatus':
        await openUrl('https://status.deepseek.com/')
        break
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:peiyucn.dsh-launcher-panel')
        break
      case 'toggleDebug': {
        const cfg = vscode.workspace.getConfiguration('dsh')
        const cur = cfg.get<boolean>('sourceDebug') ?? false
        await cfg.update('sourceDebug', !cur, vscode.ConfigurationTarget.Global)
        await this.refresh()
        break
      }
      case 'clearConsole':
        if (manager) manager.clearConsole(manager.activeInstance()?.id ?? '')
        clearConsole()
        break
      default:
        break
    }
  }

  private postToWebview(message: unknown): void {
    void this.view?.webview.postMessage(message)
  }

  /** Seed the in-panel create/edit modal. */
  private async openInstanceForm(value: string): Promise<void> {
    const manager = getInstanceManager()
    if (!manager || !this.view) return
    if (value === 'new') {
      const name = `Instance ${manager.instances().length + 1}`
      this.postToWebview({
        type: 'instanceForm',
        form: { mode: 'new', name, home: defaultInstanceHome(name), homePrefix: defaultInstanceHomePrefix() },
      })
      return
    }
    const instance = manager.instance(value)
    if (!instance) return
    this.postToWebview({
      type: 'instanceForm',
      form: {
        mode: 'edit',
        id: instance.id,
        name: instance.name,
        home: manager.homeOf(instance),
        homePrefix: defaultInstanceHomePrefix(),
        autoOpenBrowser: instance.autoOpenBrowser,
        browser: instance.browser,
      },
    })
  }

  /** Persist the modal's form and report validation errors back into it. */
  private async saveInstanceForm(value: string | undefined): Promise<void> {
    const manager = getInstanceManager()
    if (!manager || !value) return
    let payload: {
      mode?: unknown
      id?: unknown
      name?: unknown
      home?: unknown
      autoOpenBrowser?: unknown
      browser?: unknown
    }
    try {
      payload = JSON.parse(value) as typeof payload
    } catch {
      this.postToWebview({ type: 'instanceFormError', message: 'Malformed instance form' })
      return
    }
    if (typeof payload.name !== 'string' || typeof payload.home !== 'string') {
      this.postToWebview({ type: 'instanceFormError', message: 'Name and home are required' })
      return
    }
    const autoOpenBrowser = typeof payload.autoOpenBrowser === 'boolean' ? payload.autoOpenBrowser : undefined
    const browser: 'built-in' | 'external' | undefined =
      payload.browser === 'built-in' || payload.browser === 'external' ? payload.browser : undefined

    const editing = payload.mode === 'edit'
    let port: number | undefined
    let profile = 'web'
    if (editing) {
      const current = typeof payload.id === 'string' ? manager.instance(payload.id) : undefined
      if (!current) {
        this.postToWebview({ type: 'instanceFormError', message: 'Instance was not found' })
        return
      }
      // Ports are assigned by the launcher and are not edited from this form.
      port = current.port
      profile = current.profile
    } else {
      port = await manager.suggestPort()
      if (port === undefined) {
        this.postToWebview({ type: 'instanceFormError', message: 'No free Web UI port was found for the new instance' })
        return
      }
    }

    const input = {
      name: payload.name,
      home: payload.home,
      profile,
      port,
      autoOpenBrowser,
      browser,
    }
    const result = editing && typeof payload.id === 'string'
      ? await manager.update(payload.id, input).catch((error) => {
        this.postToWebview({ type: 'instanceFormError', message: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      : await manager.create(input).catch((error) => {
        this.postToWebview({ type: 'instanceFormError', message: error instanceof Error ? error.message : String(error) })
        return undefined
      })
    if (!result) return
    const error = result.issues.find((issue) => issue.severity === 'error')
    if (!result.instance || error) {
      this.postToWebview({ type: 'instanceFormError', message: error?.message ?? 'Instance was not saved' })
      return
    }
    this.postToWebview({ type: 'instanceFormSaved' })
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => void this.refresh(), STATUS_REFRESH_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      dbg('refresh skipped (no view)')
      return
    }
    try {
      const manager = getInstanceManager()
      if (!manager) {
        await this.view.webview.postMessage({ type: 'update', status: emptyStatus(), instances: [], activeId: '', issues: [], activity: [], browser: normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser')), pricing: pricingWindowAt(new Date()) })
        return
      }
      const dashboard = await manager.dashboard()
      const activity = manager.activityFor(dashboard.activeId)
      const home = dashboard.active?.home
      const showDs = home ? hasDeepSeekModel(home) : hasDeepSeekModel()
      const dsStatus = showDs ? await getDsStatus() : undefined
      const balance = showDs ? getDshBalance(home) : undefined
      const browser = normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser'))
      await this.view.webview.postMessage({
        type: 'update',
        ...dashboard,
        activity,
        browser,
        dsStatus,
        balance,
        showDs,
        pricing: pricingWindowAt(new Date()),
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[dsh-launcher-panel] refresh failed:', error)
      try {
        await this.view.webview.postMessage({
          type: 'update',
          status: emptyStatus(),
          instances: [],
          activeId: '',
          issues: [{ index: -1, field: 'entry', severity: 'error', message: `Status refresh failed: ${msg}` }],
          activity: getActivity().concat([{ id: -1, text: `✗ Status refresh failed: ${msg}`, busy: false }]),
          browser: normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser')),
          balance: undefined,
          pricing: pricingWindowAt(new Date()),
        })
      } catch {
        // Webview is gone; nothing more to do.
      }
    }
  }
}