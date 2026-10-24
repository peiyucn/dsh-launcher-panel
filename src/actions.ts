import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { normalizeBrowser, shouldOpenBrowser } from './env.ts'
import { getInstanceManager } from './instance-manager.ts'
import type { DshInstance, InstanceIssue } from './instances.ts'

/** Open a URL per dsh.browser (or one instance's override). */
export async function openUrl(url: string, browserOverride?: 'built-in' | 'external'): Promise<void> {
  const browser = browserOverride ?? normalizeBrowser(vscode.workspace.getConfiguration('dsh').get('browser'))
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

// Re-entrancy guard for the start action. (Distinct from the instance's own
// starting flag, which reflects the spawn/poll lifecycle.)
let startInFlight = false
let lastOpenAt = 0
const OPEN_DEBOUNCE_MS = 2_000

function firstError(issues: readonly InstanceIssue[]): string | undefined {
  return issues.find((issue) => issue.severity === 'error')?.message
}

/** Start (or reuse) one instance, then open its browser tab. */
export async function actionStart(id?: string): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  if (startInFlight) return
  startInFlight = true
  try {
    await manager.ready()
    const target = id ?? manager.activeInstance()?.id
    if (!target) {
      void vscode.window.showInformationMessage('Create a DSH instance first (+ in the panel).')
      return
    }
    const before = manager.statusOf(target)
    const instance = manager.instance(target)
    const ok = await manager.start(target)
    if (!ok || !instance) return
    const autoOpen = instance.autoOpenBrowser ?? (vscode.workspace.getConfiguration('dsh').get<boolean>('autoOpenBrowser') ?? true)
    if (!shouldOpenBrowser(autoOpen, before?.running ?? false)) return
    const now = Date.now()
    if (now - lastOpenAt < OPEN_DEBOUNCE_MS) return
    lastOpenAt = now
    const url = manager.uiUrl(target)
    if (url) await openUrl(url, instance.browser)
  } finally {
    startInFlight = false
  }
}

/** Stop one instance (the active one when no id is supplied). */
export async function actionStop(id?: string): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()
  const target = id ?? manager.activeInstance()?.id
  if (target) await manager.stop(target)
}

/** Open the active (or named) instance's Web UI without starting it. */
export async function actionOpen(id?: string): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()
  const target = id ?? manager.activeInstance()?.id
  if (!target) return
  const url = manager.uiUrl(target)
  if (url) await openUrl(url, manager.instance(target)?.browser)
}

/** Switch the active instance from a quick pick. */
export async function actionSelectInstance(): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()
  const instances = manager.instances()
  if (instances.length === 0) return
  const picked = await vscode.window.showQuickPick(
    instances.map((instance) => {
      const status = manager.statusOf(instance.id)
      return {
        label: instance.name,
        description: `:${instance.port}${status?.running ? ' · running' : status?.starting ? ' · starting' : ''}`,
        detail: `${instance.home || '~/.dsh'} · profile ${instance.profile}`,
        instance,
      }
    }),
    { title: 'DSH instances', placeHolder: 'Select the active instance' },
  )
  if (picked) await manager.select(picked.instance.id)
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance'
}

/** Pick a per-instance auto-open override; undefined means "use the global setting". */
async function pickAutoOpen(current?: boolean): Promise<{ value: boolean | undefined } | undefined> {
  const items: Array<{ label: string; description?: string; value: boolean | undefined }> = [
    { label: 'Use global default', value: undefined, description: current === undefined ? 'current' : undefined },
    { label: 'Always auto-open', value: true, description: current === true ? 'current' : undefined },
    { label: 'Never auto-open', value: false, description: current === false ? 'current' : undefined },
  ]
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Auto-open browser',
    placeHolder: 'Per-instance override (global default is used when unset)',
  })
  return picked ? { value: picked.value } : undefined
}

/** Pick a per-instance browser override; undefined means "use the global setting". */
async function pickBrowser(current?: 'built-in' | 'external'): Promise<{ value: 'built-in' | 'external' | undefined } | undefined> {
  const items: Array<{ label: string; description?: string; value: 'built-in' | 'external' | undefined }> = [
    { label: 'Use global default', value: undefined, description: current === undefined ? 'current' : undefined },
    { label: 'Built-in', value: 'built-in', description: current === 'built-in' ? 'current' : undefined },
    { label: 'External', value: 'external', description: current === 'external' ? 'current' : undefined },
  ]
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Browser',
    placeHolder: 'Per-instance override (global default is used when unset)',
  })
  return picked ? { value: picked.value } : undefined
}

/** Create an instance through the panel's + tab (plain input boxes). */
export async function actionCreateInstance(): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()

  const name = await vscode.window.showInputBox({
    title: 'New DSH instance',
    prompt: 'Display name',
    value: 'Instance',
    validateInput: (value) => value.trim() === '' ? 'name is required' : undefined,
  })
  if (name === undefined) return

  const options = manager.modelOptions()
  const home = await vscode.window.showInputBox({
    title: 'New DSH instance',
    prompt: 'DSH_HOME (created on Start; ~ is expanded)',
    value: path.join(options.homeDir, `.dsh-${slug(name)}`),
    validateInput: (value) => value.trim() === '' ? 'home is required' : undefined,
  })
  if (home === undefined) return

  const suggested = await manager.suggestPort()
  if (suggested === undefined) {
    void vscode.window.showErrorMessage('No free Web UI port was found for the new instance.')
    return
  }

  const autoOpen = await pickAutoOpen()
  if (autoOpen === undefined) return
  const browser = await pickBrowser()
  if (browser === undefined) return

  const result = await manager.create({
    name,
    home,
    profile: 'web',
    port: suggested,
    autoOpenBrowser: autoOpen.value,
    browser: browser.value,
  })
  const error = firstError(result.issues)
  if (!result.instance || error) {
    void vscode.window.showErrorMessage(`DSH instance was not created: ${error ?? 'unknown error'}`)
    return
  }
  await manager.select(result.instance.id)
  void vscode.window.showInformationMessage(`Instance "${result.instance.name}" created. Start it to initialize its DSH profile.`)
}

/** Edit the active (or named) instance's coordinates. */
export async function actionEditInstance(id?: string): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()
  const target = id ?? manager.activeInstance()?.id
  if (!target) return
  const current = manager.instance(target)
  if (!current) return
  const status = manager.statusOf(target)
  if (status?.running || status?.starting || status?.stopping || status?.installing) {
    void vscode.window.showWarningMessage('Stop the instance before editing it.')
    return
  }

  const name = await vscode.window.showInputBox({ title: 'Edit instance', prompt: 'Display name', value: current.name })
  if (name === undefined) return
  const home = await vscode.window.showInputBox({
    title: 'Edit instance',
    prompt: 'DSH_HOME (changing it does not move data)',
    value: manager.homeOf(current),
  })
  if (home === undefined) return

  const autoOpen = await pickAutoOpen(current.autoOpenBrowser)
  if (autoOpen === undefined) return
  const browser = await pickBrowser(current.browser)
  if (browser === undefined) return

  const result = await manager.update(target, {
    name,
    home,
    profile: current.profile,
    port: current.port,
    autoOpenBrowser: autoOpen.value,
    browser: browser.value,
  })
  const error = firstError(result.issues)
  if (!result.instance || error) void vscode.window.showErrorMessage(`Instance was not updated: ${error ?? 'unknown error'}`)
}

/** Remove the active (or named) instance from the list, never its DSH data. */
export async function actionDeleteInstance(id?: string): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()
  const target = id ?? manager.activeInstance()?.id
  if (!target) return
  const current = manager.instance(target)
  if (!current) return
  const status = manager.statusOf(target)
  if (status?.running || status?.starting || status?.stopping || status?.installing) {
    const stop = await vscode.window.showWarningMessage('Stop the instance before deleting it.', 'Stop')
    if (stop === 'Stop') await manager.stop(target)
    return
  }
  const home = manager.homeOf(current)
  const picked = await vscode.window.showWarningMessage(
    `Remove "${current.name}" from the launcher? DSH data in ${home} is not deleted.`,
    { modal: true },
    'Remove',
  )
  if (picked !== 'Remove') return
  await manager.remove(target)
}

/** Persist the browser choice (global; per-instance overrides are optional). */
export async function actionSetBrowser(value: string): Promise<void> {
  await vscode.workspace.getConfiguration('dsh').update('browser', value, vscode.ConfigurationTarget.Global)
}

/** Run the shared dsh update; refuses while any instance is active. */
export async function actionUpdateDsh(): Promise<void> {
  const manager = getInstanceManager()
  if (!manager) return
  await manager.ready()
  await manager.updateDsh()
}

/** Current instance summary for the status bar. */
export async function activeInstance(): Promise<DshInstance | undefined> {
  const manager = getInstanceManager()
  if (!manager) return undefined
  await manager.ready()
  return manager.activeInstance()
}

/** Prefix for an auto-named instance home (`<home>/.dsh-`). */
export function defaultInstanceHomePrefix(): string {
  return path.join(os.homedir(), '.dsh-')
}

/** The home directory used to suggest a new instance's default DSH_HOME. */
export function defaultInstanceHome(name: string): string {
  return defaultInstanceHomePrefix() + slug(name)
}
