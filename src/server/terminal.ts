import * as vscode from 'vscode'

export interface TerminalHost {
  addActivity: (line: string, isBusy?: boolean) => number
}

const TERMINAL_TASK_TIMEOUT_MS = 15 * 60_000
const TASK_END_GRACE_MS = 1_000
const TASK_SOURCE = 'DeepSeek Harness'

export function reportStepFailure(host: TerminalHost, activity: string, toast?: string): void {
  host.addActivity(activity)
  if (toast !== undefined) void vscode.window.showErrorMessage(toast)
}

export function runInTerminal(
  title: string, command: string, args: string[], host: TerminalHost, env?: Record<string, string>,
): Promise<boolean> {
  const task = new vscode.Task(
    { type: 'dsh-shell' },
    vscode.TaskScope.Global,
    title,
    TASK_SOURCE,
    new vscode.ShellExecution(command, args, env ? { env } : undefined),
  )
  return new Promise<boolean>((resolve) => {
    let execution: vscode.TaskExecution | undefined
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let taskEndTimer: ReturnType<typeof setTimeout> | undefined
    let processEndSub: vscode.Disposable | undefined
    let taskEndSub: vscode.Disposable | undefined

    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (watchdog !== undefined) clearTimeout(watchdog)
      if (taskEndTimer !== undefined) clearTimeout(taskEndTimer)
      processEndSub?.dispose()
      taskEndSub?.dispose()
      resolve(ok)
    }

    // A fast task can end before executeTask resolves, so match the task itself too.
    const isOurs = (candidate: vscode.TaskExecution): boolean => (
      candidate === execution
      || candidate.task === task
      || (execution === undefined && candidate.task.name === title && candidate.task.source === TASK_SOURCE)
    )

    // Listen before executing: an already-finished task must settle this promise.
    processEndSub = vscode.tasks.onDidEndTaskProcess((event) => {
      if (!isOurs(event.execution)) return
      settle(event.exitCode === 0)
    })
    taskEndSub = vscode.tasks.onDidEndTask((event) => {
      if (!isOurs(event.execution)) return
      if (taskEndTimer !== undefined) return
      // The process-end event normally arrives first; give it a moment to report the exit code.
      taskEndTimer = setTimeout(() => settle(false), TASK_END_GRACE_MS)
    })
    // A hung task must not hold the start/update locks for the rest of the session.
    watchdog = setTimeout(() => {
      host.addActivity(
        `⚠ "${title}" is taking longer than ${Math.round(TERMINAL_TASK_TIMEOUT_MS / 60_000)} minutes — reporting it as failed; it may still be running in the terminal`,
      )
      settle(false)
    }, TERMINAL_TASK_TIMEOUT_MS)

    void vscode.tasks.executeTask(task).then((ex) => {
      execution = ex
    }, () => {
      reportStepFailure(host, `✗ could not run "${title}" in a terminal`)
      settle(false)
    })
  })
}
