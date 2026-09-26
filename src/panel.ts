import * as vscode from 'vscode'
import { webcrypto } from 'node:crypto'
import { actionSetBrowser, actionStart, actionStop, openUrl } from './actions.ts'
import { DEFAULT_BROWSER, NONCE_LENGTH, normalizeBrowser } from './env.ts'
import { PEAK_WINDOWS_BJ_HOURS, pricingWindowAt } from './pricing.ts'
import { describeDshUpdate } from './versions.ts'
import { STATUS_REFRESH_INTERVAL_MS } from './timing.ts'
import { addActivity, applyMode, clearConsole, clearRequirementsCaches, currentStatus, dbg, fetchDshBalance, isCheckingUpdates, isUpdating, getActivity, getDsStatus, getDshBalance, hasDeepSeekModel, readConfig, runDshUpdate, beginUpdateCheck, endUpdateCheck, withBusy, type ServerStatus } from './server.ts'
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
    switch (message.command) {
      case 'start':
        await actionStart()
        break
      case 'stop':
        await actionStop()
        break
      case 'updateDsh':
        await runDshUpdate()
        break
      case 'refreshRequirements':
        // The spinner and the `checking` flag (which greys the button) must be
        // released even when the check throws, and must stay set for the whole
        // handler: `clearRequirementsCaches` runs a check of its own, so an
        // inner release would re-enable the button while this one still runs.
        // The counter in server.ts makes nesting safe; this pair only brackets.
        beginUpdateCheck()
        try {
          await withBusy('↻ Checking for updates…', async () => {
            await this.refresh()
            await clearRequirementsCaches()
            const st = await currentStatus()
            addActivity(
              !st.dshVersion
                ? 'ℹ dsh is not installed yet — use Install & Start'
                : describeDshUpdate(st.update),
            )
          })
        } finally {
          endUpdateCheck()
        }
        break
      case 'setMode':
        if (message.value === 'pnpm' || message.value === 'source') {
          const st = await currentStatus()
          const active = st.running || st.starting || st.installing
          if (active) {
            // The snapshot can be stale by the time this runs: confirm for
            // every active state so cancelling always keeps the current
            // mode, and a start that completed mid-flight is never stopped
            // without asking.
            const pick = await vscode.window.showInformationMessage(
              `DeepSeek Harness is ${st.running ? 'running' : 'starting'} — switch to ${message.value} mode?`,
              st.running ? 'Restart' : 'Switch',
              'Cancel',
            )
            if (pick === 'Cancel' || !pick) break
            await actionStop()
            await applyMode(message.value)
            if (st.running) await actionStart()
          } else {
            await applyMode(message.value)
          }
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
          await fetchDshBalance()
          const b = getDshBalance()
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
        clearConsole()
        break
      default:
        break
    }
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
      const status = await currentStatus()
      const activity = getActivity()
      const showDs = hasDeepSeekModel()
      const dsStatus = showDs ? await getDsStatus() : undefined
      const balance = showDs ? getDshBalance() : undefined
      // Read browser AFTER the slow awaits: a refresh that started before a
      // setBrowser click would otherwise deliver a stale value and flip the
      // trigger back for one cycle.
      const browser = normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser'))
      await this.view.webview.postMessage({ type: 'update', status, activity, browser, dsStatus, balance, showDs, pricing: pricingWindowAt(new Date()) })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[dsh-launcher-panel] refresh failed:', error)
      // Typed fallback so it stays in sync with ServerStatus (no drifting fields).
      const cfg = readConfig()
      const fallback: ServerStatus = {
        running: false,
        starting: false,
        installing: false,
        stopping: false,
        checking: isCheckingUpdates(),
        updating: isUpdating(),
        url: '',
        dsh: 'unknown',
        dshVersion: '',
        dshPath: '',
        dshHome: '',
        dshPathShort: '',
        dshHomeShort: '',
        nodeVersion: '',
        mode: cfg.runMode,
        update: undefined,
        consoleLogPath: '',
        consoleLogPathShort: '',
        serverLogPath: '',
        serverLogPathShort: '',
        consoleLogSize: 0,
        serverLogSize: 0,
        sourceDebug: cfg.sourceDebug,
      }
      try {
        // Carry the REAL browser setting even on failure: a hardcoded 'built-in'
        // here made the trigger flip between failed and successful refreshes.
        const browser = normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser'))
        await this.view.webview.postMessage({
          type: 'update',
          status: fallback,
          activity: [{ text: `✗ Status refresh failed: ${msg}`, busy: false }],
          browser,
          balance: undefined,
          pricing: pricingWindowAt(new Date()),
        })
      } catch {
        // Webview is gone; nothing more to do.
      }
    }
  }
}