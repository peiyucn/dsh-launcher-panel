import * as vscode from 'vscode'
import { DEFAULT_BROWSER, shouldOpenBrowser } from './common'
import { currentStatus, ensureRunning, readConfig, stopServer, uiUrl } from './server'

/** Open a URL per dsh.browser: built-in Simple Browser (with fallback) or external. */
export async function openUrl(url: string): Promise<void> {
  const browser = vscode.workspace.getConfiguration('dsh').get<string>('browser') ?? DEFAULT_BROWSER
  if (browser === 'external') {
    await vscode.env.openExternal(vscode.Uri.parse(url))
    return
  }
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url)
  } catch {
    void vscode.window.showInformationMessage('VS Code built-in browser is unavailable; opened the system browser instead.')
    await vscode.env.openExternal(vscode.Uri.parse(url))
  }
}

// Re-entrancy guard for the start action. (Distinct from server.ts's
// `starting` status flag, which reflects the spawn/poll lifecycle.)
let startInFlight = false
let lastOpenAt = 0
const OPEN_DEBOUNCE_MS = 2_000

/** Start (or reuse) the server, then open the browser. */
export async function actionStart(): Promise<void> {
  if (startInFlight) return
  startInFlight = true
  try {
    const cfg = readConfig()
    // No launch notification: the dashboard already shows the live status
    // and console, so start silently and let the panel report progress.
    const alreadyRunning = (await currentStatus()).running
    const ok = await ensureRunning(cfg)
    if (!ok) return
    // dsh.autoOpenBrowser off → no automatic tab; the explicit 'New Tab'
    // click (alreadyRunning) always opens per dsh.browser.
    if (!shouldOpenBrowser(cfg.autoOpenBrowser, alreadyRunning)) return
    // Debounce browser opens so rapid clicks on the status bar (or the panel
    // Start button while running) don't spawn one tab per click.
    const now = Date.now()
    if (now - lastOpenAt < OPEN_DEBOUNCE_MS) return
    lastOpenAt = now
    // Always (re)open the browser — DSH is fine with multiple pages, and this
    // way a closed tab can always be reopened by clicking again.
    await openUrl(uiUrl())
  } finally {
    startInFlight = false
  }
}

/** Stop the server. The outcome is reported in the panel console, not a toast. */
export async function actionStop(): Promise<void> {
  await stopServer()
}

export async function actionSetBrowser(value: string): Promise<void> {
  await vscode.workspace.getConfiguration('dsh').update('browser', value, vscode.ConfigurationTarget.Global)
}
