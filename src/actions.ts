import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { normalizeBrowser, shouldOpenBrowser } from './env.ts'
import { getInstanceManager, type InstanceManager } from './instance-manager.ts'
import type { InstanceIssue } from './instances.ts'
import type { InstanceRuntimeStatus } from './server/instance-runtime.ts'

/** Run `task` with the ready manager; no-op before activation. */
async function withManager<T>(task: (manager: InstanceManager) => Promise<T>): Promise<T | undefined> {
  const manager = getInstanceManager()
  if (!manager) return undefined
  await manager.ready()
  return task(manager)
}

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

// Guards a start click against a second click while the spawn/poll is still running.
let startInFlight = false
let lastOpenAt = 0
const OPEN_DEBOUNCE_MS = 2_000

function firstError(issues: readonly InstanceIssue[]): string | undefined {
  return issues.find((issue) => issue.severity === 'error')?.message
}

function instanceBusy(status: InstanceRuntimeStatus | undefined): boolean {
  return status !== undefined && (status.running || status.starting || status.stopping || status.installing)
}

export async function actionStart(id?: string): Promise<void> {
  if (startInFlight) return
  startInFlight = true
  try {
    await withManager(async (manager) => {
      const target = id ?? manager.activeInstance()?.id
      if (!target) {
        void vscode.window.showInformationMessage('Create a DSH instance first (+ in the panel).')
        return
      }
      const before = manager.statusOf(target)
      const instance = manager.instance(target)
      if (!(await manager.start(target)) || !instance) return
      const autoOpen = instance.autoOpenBrowser ?? (vscode.workspace.getConfiguration('dsh').get<boolean>('autoOpenBrowser') ?? true)
      if (!shouldOpenBrowser(autoOpen, before?.running ?? false)) return
      const now = Date.now()
      if (now - lastOpenAt < OPEN_DEBOUNCE_MS) return
      lastOpenAt = now
      const url = manager.uiUrl(target)
      if (url) await openUrl(url, instance.browser)
    })
  } finally {
    startInFlight = false
  }
}

export async function actionStop(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (target) await stopInstance(manager, target)
  })
}

export async function actionRestart(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const status = manager.statusOf(target)
    const occupied = instanceBusy(status) || status?.adopted === true || status?.untrackedPort === true
    // A refused or failed stop leaves the port taken; starting would only hit "port already in use".
    if (occupied && !(await stopInstance(manager, target))) return
    await actionStart(target)
  })
}

const STOP_PORT_OWNER = 'Stop and kill the port owner'

/** Kill a port owner the launcher does not track only after explicit consent (spec §8/§12). */
async function stopInstance(manager: InstanceManager, target: string): Promise<boolean> {
  if (await manager.stopNeedsConfirmation(target)) {
    const instance = manager.instance(target)
    const name = instance?.name ?? target
    const port = instance?.port ?? manager.statusOf(target)?.port ?? '?'
    const confirmed = await vscode.window.showWarningMessage(
      `Stop "${name}"? Port ${port} is held by a process the launcher did not start. `
        + 'Continue only if that process is this instance\'s DSH server.',
      { modal: true },
      STOP_PORT_OWNER,
    )
    if (confirmed !== STOP_PORT_OWNER) return false
    const stopped = await manager.stop(target, true)
    if (!stopped) void vscode.window.showWarningMessage(`"${name}" was not stopped: port ${port} is still in use.`)
    return stopped
  }
  const stopped = await manager.stop(target)
  if (!stopped && instanceBusy(manager.statusOf(target))) {
    void vscode.window.showWarningMessage(`"${manager.instance(target)?.name ?? target}" was not stopped — see the launcher activity log for the reason.`)
  }
  return stopped
}

export async function actionOpen(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const url = manager.uiUrl(target)
    if (url) await openUrl(url, manager.instance(target)?.browser)
  })
}

export async function actionSelectInstance(): Promise<void> {
  await withManager(async (manager) => {
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
  })
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance'
}

async function pickOverride<T extends string | boolean | undefined>(
  title: string,
  placeHolder: string,
  choices: Array<{ label: string; value: T | undefined }>,
  current?: T,
): Promise<{ value: T | undefined } | undefined> {
  const picked = await vscode.window.showQuickPick(
    choices.map((choice) => ({ label: choice.label, value: choice.value, description: choice.value === current ? 'current' : undefined })),
    { title, placeHolder },
  )
  return picked ? { value: picked.value } : undefined
}

function pickAutoOpen(current?: boolean): Promise<{ value: boolean | undefined } | undefined> {
  return pickOverride('Auto-open browser', 'Per-instance override (global default is used when unset)', [
    { label: 'Use global default', value: undefined },
    { label: 'Always auto-open', value: true },
    { label: 'Never auto-open', value: false },
  ], current)
}

function pickBrowser(current?: 'built-in' | 'external'): Promise<{ value: 'built-in' | 'external' | undefined } | undefined> {
  return pickOverride('Browser', 'Per-instance override (global default is used when unset)', [
    { label: 'Use global default', value: undefined },
    { label: 'Built-in', value: 'built-in' },
    { label: 'External', value: 'external' },
  ], current)
}

export async function actionCreateInstance(): Promise<void> {
  await withManager(async (manager) => {
    const name = await vscode.window.showInputBox({
      title: 'New DSH instance',
      prompt: 'Display name',
      value: 'Instance',
      validateInput: (value) => value.trim() === '' ? 'name is required' : undefined,
    })
    if (name === undefined) return

    const home = await vscode.window.showInputBox({
      title: 'New DSH instance',
      prompt: 'DSH_HOME (created on Start; ~ is expanded)',
      value: defaultInstanceHome(name),
      validateInput: (value) => value.trim() === '' ? 'home is required' : undefined,
    })
    if (home === undefined) return

    const port = await manager.suggestPort()
    if (port === undefined) {
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
      port,
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
  })
}

export async function actionEditInstance(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const current = manager.instance(target)
    if (!current) return
    if (instanceBusy(manager.statusOf(target))) {
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
  })
}

export async function actionDeleteInstance(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const current = manager.instance(target)
    if (!current) return
    if (instanceBusy(manager.statusOf(target))) {
      const stop = await vscode.window.showWarningMessage('Stop the instance before deleting it.', 'Stop')
      if (stop === 'Stop') await stopInstance(manager, target)
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
  })
}

export async function actionSetBrowser(value: string): Promise<void> {
  await vscode.workspace.getConfiguration('dsh').update('browser', value, vscode.ConfigurationTarget.Global)
}

export async function actionUpdateDsh(): Promise<void> {
  await withManager((manager) => manager.updateDsh())
}

export function defaultInstanceHomePrefix(): string {
  return path.join(os.homedir(), '.dsh-')
}

export function defaultInstanceHome(name: string): string {
  return defaultInstanceHomePrefix() + slug(name)
}
