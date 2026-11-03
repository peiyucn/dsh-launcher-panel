import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { normalizeBrowser, shouldOpenBrowser } from './shared/env.ts'
import { getInstanceManager, type InstanceManager } from './instances/manager.ts'
import { isObservedInstance } from './instances/model.ts'
import { detectedName, type DetectedDsh } from './instances/discovery.ts'
import type { InstanceIssue } from './instances/model.ts'
import type { InstanceRuntimeStatus } from './instances/runtime/runtime.ts'

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
      if (!instance) return
      if (isObservedInstance(instance)) {
        void vscode.window.showInformationMessage(`"${instance.name}" is a detected dsh — start it outside the launcher.`)
        return
      }
      if (!(await manager.start(target))) return
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
    if (!target) return
    const instance = manager.instance(target)
    if (instance && isObservedInstance(instance)) {
      void vscode.window.showInformationMessage(`"${instance.name}" is a detected dsh — stop it outside the launcher.`)
      return
    }
    // A failed stop is reported by the runtime itself (panel error line + activity feed);
    // Stop never kills a port owner it cannot identify, so there is nothing to ask about.
    await manager.stop(target)
  })
}

export async function actionRestart(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const instance = manager.instance(target)
    if (instance && isObservedInstance(instance)) {
      void vscode.window.showInformationMessage(`"${instance.name}" is a detected dsh — restart it outside the launcher.`)
      return
    }
    const status = manager.statusOf(target)
    const occupied = instanceBusy(status) || status?.adopted === true || status?.untrackedPort === true
    // A refused or failed stop leaves the port taken; starting would only hit "port already in use".
    if (occupied && !(await manager.stop(target))) return
    await actionStart(target)
  })
}

export async function actionOpen(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const status = manager.statusOf(target)
    if (status?.observed && !status.uiAvailable) {
      void vscode.window.showInformationMessage('This detected dsh is running, but its launch token could not be resolved — start it outside the launcher or check its logs.')
      return
    }
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
    if (isObservedInstance(current)) {
      const name = await vscode.window.showInputBox({
        title: 'Rename detected instance',
        prompt: 'Display name (home, profile and port stay read-only)',
        value: current.name,
      })
      if (name === undefined) return
      const renamed = await manager.renameObserved(target, name)
      const renameError = firstError(renamed.issues)
      if (!renamed.instance || renameError) {
        void vscode.window.showErrorMessage(`Instance was not renamed: ${renameError ?? 'unknown error'}`)
      }
      return
    }
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
      if (stop === 'Stop') await manager.stop(target)
      return
    }
    const home = manager.homeOf(current)
    const detail = isObservedInstance(current) || home === ''
      ? 'the detected dsh process is not affected'
      : `DSH data in ${home} is not deleted`
    const picked = await vscode.window.showWarningMessage(
      `Remove "${current.name}" from the launcher? ${detail}.`,
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

/** Explicitly rebuild dsh with the configured import method (staged, never in place). */
export async function actionReinstallDsh(): Promise<void> {
  await withManager(async (manager) => {
    if (manager.anyActive()) {
      void vscode.window.showWarningMessage('Stop all DSH instances before reinstalling dsh.')
      return
    }
    const method = vscode.workspace.getConfiguration('dsh').get<string>('packageImportMethod') ?? 'copy'
    const picked = await vscode.window.showWarningMessage(
      `Reinstall dsh with the "${method}" package import method? It is built in a staging folder and switched in only when complete; all instances must stay stopped.`,
      { modal: true },
      'Reinstall',
    )
    if (picked !== 'Reinstall') return
    const ok = await manager.reinstallDsh()
    if (!ok) void vscode.window.showErrorMessage('dsh reinstall failed — see the activity log and terminal output.')
  })
}

interface DetectPick extends vscode.QuickPickItem {
  entry?: DetectedDsh
}

/** One-shot, user-triggered detection of dsh servers the launcher did not start. */
export async function actionDetectDsh(): Promise<void> {
  await withManager(async (manager) => {
    // One QuickPick for the whole interaction: it opens with a busy spinner while the
    // process scan runs (seconds on Windows), then turns into the selection list or a
    // "nothing found" row in place. No second popup.
    const picked = await new Promise<DetectPick[] | undefined>((resolve) => {
      const quickPick = vscode.window.createQuickPick<DetectPick>()
      let settled = false
      const finish = (value: DetectPick[] | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      quickPick.title = 'Detect running dsh'
      quickPick.canSelectMany = true
      quickPick.busy = true
      quickPick.placeholder = 'Scanning for dsh servers this launcher did not start…'
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems.filter((item) => item.entry !== undefined)
        quickPick.hide()
        finish(selected.length === 0 ? undefined : selected)
      })
      quickPick.onDidHide(() => finish(undefined))
      quickPick.show()
      void (async () => {
        const detected = await manager.detectRunningDsh()
        if (settled) return
        quickPick.busy = false
        if (detected.length === 0) {
          quickPick.items = [{
            label: 'No running dsh servers were detected on this machine',
            detail: 'Start a dsh server outside the launcher (systemd/docker/manual), then run Detect again.',
          }]
          quickPick.placeholder = 'Nothing detected'
          return
        }
        quickPick.items = detected.map((entry) => ({
          label: detectedName(entry.profile, entry.port),
          description: `${entry.profile || 'dsh'} :${entry.port}`,
          detail: entry.home === '' ? entry.command : entry.home,
          entry,
        }))
        quickPick.placeholder = 'Select one or more running dsh servers to add as read-only instances'
      })()
    })
    if (picked === undefined) return
    const result = await manager.takeOverDetected(picked.map((item) => item.entry as DetectedDsh))
    if (result.error !== undefined) {
      void vscode.window.showErrorMessage(`Could not save the detected instances: ${result.error}`)
      return
    }
    void vscode.window.showInformationMessage(`Added ${result.created.length} detected dsh instance(s). Open one from the panel to attach.`)
  })
}

/** Copy a token-free takeover briefing for an observed instance. */
export async function actionCopyObservedInfo(id?: string): Promise<void> {
  await withManager(async (manager) => {
    const target = id ?? manager.activeInstance()?.id
    if (!target) return
    const instance = manager.instance(target)
    if (!instance || !isObservedInstance(instance)) return
    const info = await manager.takeoverInfo(target)
    if (info === undefined) return
    await vscode.env.clipboard.writeText(info)
    void vscode.window.showInformationMessage('Takeover info copied — hand it to an agent to convert this dsh into a launcher-managed instance.')
  })
}

export function defaultInstanceHomePrefix(): string {
  return path.join(os.homedir(), '.dsh-')
}

export function defaultInstanceHome(name: string): string {
  return defaultInstanceHomePrefix() + slug(name)
}
