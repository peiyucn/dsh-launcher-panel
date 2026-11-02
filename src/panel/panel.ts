import * as vscode from 'vscode'
import { webcrypto } from 'node:crypto'
import { DEFAULT_BROWSER, NONCE_LENGTH, normalizeBrowser } from '../shared/env.ts'
import { getDshBalance, getDsStatus, hasDeepSeekModel } from './deepseek.ts'
import { getInstanceManager } from '../instances/manager.ts'
import { PEAK_WINDOWS_BJ_HOURS, pricingWindowAt } from './pricing.ts'
import { PANEL_REFRESH_INTERVAL_MS } from '../shared/timing.ts'
import { dbg, getActivity } from '../shared/activity.ts'
import {
  buildPanelUpdate,
  type PanelHostMessage,
  type PanelStatus,
  type PanelUpdate,
} from './webview/panel-contract.ts'
import { createRefreshScheduler } from './webview/panel-refresh.ts'
import { PANEL_CSS } from './webview/panel-styles.ts'
import { panelBody } from './webview/panel-body.ts'
import { panelScript } from './webview/panel-script.ts'
import { errorMessage, PanelMessages } from './messages.ts'

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(NONCE_LENGTH)
  webcrypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < NONCE_LENGTH; i++) out += chars.charAt(bytes[i] % chars.length)
  return out
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
  private readonly messages: PanelMessages

  constructor(private readonly version: string) {
    this.messages = new PanelMessages({
      hasView: () => this.view !== undefined,
      busy: () => this.refresher.busy,
      post: (message) => this.postToWebview(message),
      requestRefresh: () => this.requestRefresh(),
    })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    dbg(`view resolved, visible=${view.visible}`)
    view.webview.options = { enableScripts: true }
    view.webview.html = this.getHtml()
    view.webview.onDidReceiveMessage((message: unknown) => this.messages.handleRaw(message))
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

  private postToWebview(message: PanelHostMessage): void {
    void this.view?.webview.postMessage(message)
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
        activity: getActivity(activeId).concat([{ id: -1, text: `✗ Status refresh failed: ${reason}`, busy: false }]),
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
