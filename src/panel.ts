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
} from './actions.ts'
import { DEFAULT_BROWSER, NONCE_LENGTH, normalizeBrowser } from './env.ts'
import { fetchDshBalance, getDshBalance, getDsStatus, hasDeepSeekModel } from './ds.ts'
import { getInstanceManager } from './instance-manager.ts'
import { parseInstanceFormPayload } from './panel-form.ts'
import { PEAK_WINDOWS_BJ_HOURS, pricingWindowAt } from './pricing.ts'
import { describeDshUpdate } from './versions.ts'
import { PANEL_REFRESH_INTERVAL_MS } from './timing.ts'
import { addActivity, clearConsole, dbg, getActivity, withBusy } from './server/activity.ts'
import { writeRunMode } from './server/config.ts'
import {
  buildPanelUpdate,
  isBrowserChoice,
  PANEL_COMMANDS,
  PANEL_MESSAGE_TYPES,
  type PanelInstanceForm,
  type PanelInstanceFormErrorMessage,
  type PanelInstanceFormMessage,
  type PanelInstanceFormSavedMessage,
  type PanelMessage,
  type PanelStatus,
  type PanelUpdate,
} from './webview/panel-contract.ts'
import { createRefreshScheduler } from './webview/panel-refresh.ts'
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

/** One-line message for an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The status shape used before the manager exists or when a refresh throws. */
function emptyStatus(): PanelStatus {
  const cfg = vscode.workspace.getConfiguration('dsh')
  return {
    running: false,
    starting: false,
    installing: false,
    stopping: false,
    checking: false,
    updating: false,
    unknown: false,
    url: '',
    dsh: 'unknown',
    dshVersion: '',
    dshPath: '',
    dshHome: '',
    dshPathShort: '',
    dshHomeShort: '',
    nodeVersion: '',
    mode: cfg.get<string>('runMode') === 'source' ? 'source' : 'pnpm',
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
  /** Last successful payload; used as the fallback when a refresh throws. */
  private lastUpdate: PanelUpdate | undefined
  private readonly refresher = createRefreshScheduler(() => this.refreshOnce())

  constructor(private readonly version: string) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    dbg(`view resolved, visible=${view.visible}`)
    view.webview.options = { enableScripts: true }
    view.webview.html = this.getHtml()
    view.webview.onDidReceiveMessage((message: unknown) => {
      // A malformed message (null, a primitive, ...) must stay inside this
      // handler: an exception escaping the extension's own webview entry point
      // becomes an unhandled rejection in VS Code's message pipeline.
      if (typeof message !== 'object' || message === null) {
        dbg(`ignored non-object webview message: ${String(message)}`)
        return
      }
      const msg = message as PanelMessage
      dbg(`message from webview: ${JSON.stringify(msg)}`)
      if (msg.command === PANEL_COMMANDS.ready) {
        // The refresh started by resolveWebviewView may still be in flight; it
        // posts after the webview is listening, so let it finish instead of
        // queueing a duplicate. If it already finished, its post may have
        // raced the webview's message listener, so ask for a fresh snapshot.
        if (!this.refresher.busy) void this.requestRefresh()
        return
      }
      void this.onMessage(msg)
    })
    view.onDidChangeVisibility(() => {
      dbg(`visibility changed, visible=${view.visible}`)
      if (view.visible) {
        this.startTimer()
        // Do not make the user wait up to one timer tick for fresh data.
        void this.requestRefresh()
      } else {
        this.stopTimer()
      }
    })
    view.onDidDispose(() => {
      this.stopTimer()
      // Do not keep a reference to a destroyed webview for the provider's
      // lifetime; posting to it would be a no-op at best.
      this.view = undefined
    })
    if (view.visible) this.startTimer()
    void this.requestRefresh()
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
  private async onMessage(message: PanelMessage): Promise<void> {
    const command = typeof message.command === 'string' ? message.command : '(unknown)'
    try {
      await this.handleMessage(message)
    } catch (error) {
      const msg = errorMessage(error)
      dbg(`webview command "${command}" failed: ${msg}`)
      addActivity(`✗ Command failed (${command}): ${msg}`)
    }
    // Single-flight + trailing merge: the refresh also covers the manager's own
    // refresh (dashboard() calls it), so handlers must not refresh separately.
    await this.requestRefresh()
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    const manager = getInstanceManager()
    switch (message.command) {
      case 'start':
        await actionStart(message.value)
        break
      case 'stop':
        await actionStop(message.value)
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
      case 'deleteInstance':
        await actionDeleteInstance(message.value)
        break
      case 'updateDsh':
        try {
          await actionUpdateDsh()
        } catch (error) {
          void vscode.window.showErrorMessage(`DSH update failed: ${errorMessage(error)}`)
        }
        break
      case 'refreshRequirements': {
        // The trailing refresh renders the status, including the update this
        // check just cached; asking the manager again here doubled the probes.
        const update = await manager?.checkUpdate(true)
        addActivity(describeDshUpdate(update))
        break
      }
      case 'setMode':
        if (message.value === 'pnpm' || message.value === 'source') {
          if (manager?.anyActive()) {
            void vscode.window.showWarningMessage('Stop all DSH instances before switching run mode.')
            break
          }
          await writeRunMode(message.value)
          manager?.invalidateDetection()
        } else {
          dbg(`ignored setMode with invalid value: ${JSON.stringify(message.value)}`)
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
        // Validate against the real enum: writing an arbitrary client string
        // into `dsh.browser` would only be folded back on read.
        if (isBrowserChoice(message.value)) await actionSetBrowser(message.value)
        else dbg(`ignored setBrowser with invalid value: ${JSON.stringify(message.value)}`)
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
        break
      }
      case 'clearConsole':
        if (manager) manager.clearConsole(manager.activeInstance()?.id ?? '')
        clearConsole()
        break
      default:
        dbg(`ignored unknown webview command: ${JSON.stringify(message.command)}`)
        break
    }
  }

  private postToWebview(message: unknown): void {
    void this.view?.webview.postMessage(message)
  }

  private postInstanceFormError(message: string): void {
    const error: PanelInstanceFormErrorMessage = { type: PANEL_MESSAGE_TYPES.instanceFormError, message }
    this.postToWebview(error)
  }

  /** Seed the in-panel create/edit modal. */
  private async openInstanceForm(value: string): Promise<void> {
    const manager = getInstanceManager()
    if (!manager) {
      // Surface the reason instead of returning silently: a click that does
      // nothing at all reads as a broken panel.
      this.postInstanceFormError('Launcher is not ready yet — try again in a moment')
      return
    }
    if (!this.view) return
    // The form's prefilled name (and the edit form's fields) come from the
    // settings list: waiting for the bootstrap keeps the prefill consistent
    // with what the save will validate against.
    await manager.ready().catch(() => {})
    if (value === 'new') {
      const name = `Instance ${manager.instances().length + 1}`
      const form: PanelInstanceForm = { mode: 'new', name, home: defaultInstanceHome(name), homePrefix: defaultInstanceHomePrefix() }
      this.postToWebview({ type: PANEL_MESSAGE_TYPES.instanceForm, form } satisfies PanelInstanceFormMessage)
      return
    }
    const instance = manager.instance(value)
    if (!instance) {
      this.postInstanceFormError('Instance was not found')
      return
    }
    const form: PanelInstanceForm = {
      mode: 'edit',
      id: instance.id,
      name: instance.name,
      home: manager.homeOf(instance),
      homePrefix: defaultInstanceHomePrefix(),
      autoOpenBrowser: instance.autoOpenBrowser,
      browser: instance.browser,
    }
    this.postToWebview({ type: PANEL_MESSAGE_TYPES.instanceForm, form } satisfies PanelInstanceFormMessage)
  }

  /** Persist the modal's form and report validation errors back into it. */
  private async saveInstanceForm(value: string | undefined): Promise<void> {
    const manager = getInstanceManager()
    if (!manager) {
      this.postInstanceFormError('Launcher is not ready yet — try again in a moment')
      return
    }
    // Wait for the bootstrap before reading the instance being edited: a save
    // that raced the first-run setup would otherwise validate against an empty
    // list and report a bogus "already used" (or lose the instance).
    await manager.ready().catch(() => {})
    const parsed = parseInstanceFormPayload(value)
    if (!parsed.ok) {
      this.postInstanceFormError(parsed.message)
      return
    }
    const form = parsed.form
    const editing = form.mode === 'edit'
    let port: number | undefined
    let profile = 'web'
    if (editing) {
      const current = form.id ? manager.instance(form.id) : undefined
      if (!current) {
        this.postInstanceFormError('Instance was not found')
        return
      }
      // Ports are assigned by the launcher and are not edited from this form.
      port = current.port
      profile = current.profile
    } else {
      port = await manager.suggestPort()
      if (port === undefined) {
        this.postInstanceFormError('No free Web UI port was found for the new instance')
        return
      }
    }

    const input = {
      name: form.name,
      home: form.home,
      profile,
      port,
      autoOpenBrowser: form.autoOpenBrowser,
      browser: form.browser,
    }
    const result = editing
      ? await manager.update(form.id, input).catch((error) => {
        this.postInstanceFormError(errorMessage(error))
        return undefined
      })
      : await manager.create(input).catch((error) => {
        this.postInstanceFormError(errorMessage(error))
        return undefined
      })
    if (!result) return
    const error = result.issues.find((issue) => issue.severity === 'error')
    if (!result.instance || error) {
      this.postInstanceFormError(error?.message ?? 'Instance was not saved')
      return
    }
    const saved: PanelInstanceFormSavedMessage = { type: PANEL_MESSAGE_TYPES.instanceFormSaved }
    this.postToWebview(saved)
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

  /**
   * Ask for a dashboard refresh. Concurrent requests are serialized and merged
   * by {@link createRefreshScheduler}: the panel timer and every webview command
   * land here, so a slow probe cannot multiply into overlapping refreshes.
   */
  requestRefresh(): Promise<void> {
    return this.refresher.request()
  }

  /**
   * Build and post one dashboard snapshot.
   *
   * Never rejects: a failure has to become a payload the panel can render, and
   * the scheduler has to remain usable for the next tick.
   */
  private async refreshOnce(): Promise<void> {
    const view = this.view
    if (!view) {
      dbg('refresh skipped (no view)')
      return
    }
    try {
      const browser = normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser'))
      const manager = getInstanceManager()
      if (!manager) {
        await view.webview.postMessage(buildPanelUpdate({ status: emptyStatus(), browser, pricing: pricingWindowAt(new Date()) }))
        return
      }
      const dashboard = await manager.dashboard()
      const activity = manager.activityFor(dashboard.activeId)
      const home = dashboard.active?.home
      const showDs = home ? hasDeepSeekModel(home) : hasDeepSeekModel()
      const dsStatus = showDs ? await getDsStatus() : undefined
      const balance = showDs ? getDshBalance(home) : undefined
      const update = buildPanelUpdate({
        status: dashboard.status,
        instances: dashboard.instances,
        active: dashboard.active,
        activeId: dashboard.activeId,
        issues: dashboard.issues,
        activity,
        browser,
        dsStatus,
        balance,
        showDs,
        pricing: pricingWindowAt(new Date()),
      })
      this.lastUpdate = update
      await view.webview.postMessage(update)
    } catch (error) {
      console.error('[dsh-launcher-panel] refresh failed:', error)
      try {
        await this.postRefreshFailure(view, errorMessage(error))
      } catch {
        // The fallback itself failed (webview gone); the scheduler must stay
        // usable for the next tick, so swallow it here.
      }
    }
  }

  /**
   * Post the last good snapshot plus the failure, instead of a fresh empty one.
   *
   * Resetting to `emptyStatus()` claimed the server was stopped (and dropped
   * `active`/`showDs`/`dsStatus`, which disabled Start and showed "+ New" while
   * instances still existed). Reusing the last snapshot keeps the panel honest:
   * the status block is marked `unknown` and rendered as such.
   */
  private async postRefreshFailure(view: vscode.WebviewView, reason: string): Promise<void> {
    const manager = getInstanceManager()
    const previous = this.lastUpdate
    const issues = manager?.issues() ?? []
    const status: PanelStatus = previous
      ? { ...previous.status, unknown: true, running: false, starting: false, installing: false, stopping: false, checking: false, updating: false, url: '' }
      : { ...emptyStatus(), unknown: true }
    // Prefer whatever the manager can still answer (it may hold fresher state
    // than the last snapshot); fall back to the snapshot when it cannot — a
    // failed bootstrap returns empty lists and would blank the instance view.
    const freshInstances = manager?.instanceStatuses() ?? []
    const instances = freshInstances.length > 0 ? freshInstances : (previous?.instances ?? [])
    const activeId = manager?.activeInstanceId() || previous?.activeId || ''
    const active = manager ? (manager.statusOf(activeId) ?? previous?.active) : previous?.active
    const home = active?.home
    const fallback = buildPanelUpdate({
      status,
      instances,
      active,
      activeId,
      issues: [...issues, { index: -1, field: 'entry', severity: 'error', message: `Status refresh failed: ${reason}` }],
      activity: getActivity().concat([{ id: -1, text: `✗ Status refresh failed: ${reason}`, busy: false }]),
      browser: normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser')),
      dsStatus: previous?.dsStatus,
      balance: previous?.balance,
      showDs: previous?.showDs ?? (home ? hasDeepSeekModel(home) : false),
      pricing: pricingWindowAt(new Date()),
    })
    try {
      await view.webview.postMessage(fallback)
    } catch {
      // Webview is gone; nothing more to do.
    }
  }
}
