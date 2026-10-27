/**
 * Running a command in a visible VS Code terminal.
 *
 * Setup and update steps run here rather than through the process layer,
 * because they are user-facing: the terminal shows progress, and the user can
 * read the output when a build fails. The alternative — capturing the output —
 * would hide the one thing they need at that moment.
 *
 * Arguments are passed as an array so VS Code quotes them for the active shell.
 * Paths never go through manual string interpolation, which breaks on
 * `$`/backticks/parentheses in PowerShell and `%`/`&` in cmd.
 *
 * A terminal task can outlive the panel or hang on an interactive prompt, and
 * the start/update flows hold their locks until this promise settles. A
 * watchdog plus an `onDidEndTask` fallback therefore make the promise settle no
 * matter what the task does.
 *
 * @module server/terminal
 */

import * as vscode from 'vscode'

/** What the terminal layer needs from the lifecycle it runs inside. */
export interface TerminalHost {
  /** Report into the panel feed; returns the entry id. */
  addActivity: (line: string, isBusy?: boolean) => number
}

/**
 * Upper bound for one terminal step. Setup/build/fetch steps normally finish in
 * minutes; past this the step is reported as failed and left running, so the
 * caller's locks are released instead of hanging for the session.
 */
const TERMINAL_TASK_TIMEOUT_MS = 15 * 60_000

/**
 * How long to wait after `onDidEndTask` for the process-end event that carries
 * the exit code. A task terminated by the user (or a terminal closed mid-run)
 * can end without that event, and then the step counts as failed.
 */
const TASK_END_GRACE_MS = 1_000

/** The terminal task's owner label (matches the `Task` source below). */
const TASK_SOURCE = 'DeepSeek Harness'

/**
 * Report a failed setup/update step: one activity line plus, when it helps the
 * user act, a toast. Callers report every failure — a failed step must not be
 * silently dropped just because no start flow is active (e.g. during Update).
 */
export function reportStepFailure(host: TerminalHost, activity: string, toast?: string): void {
  host.addActivity(activity)
  if (toast !== undefined) void vscode.window.showErrorMessage(toast)
}

/**
 * Run a command in a visible VS Code terminal.
 *
 * `env` entries are merged into the terminal process environment, which is how
 * the source-mode build requests dsh's official client profile.
 *
 * The returned promise always settles: on the task's process exit, when the
 * task ends without a process exit, when the task cannot be started, or when
 * the watchdog expires. In the last case the task is left running on purpose —
 * a long build may still finish — but the caller is told it may still be there.
 *
 * @returns true when the command exited 0.
 */
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

    // A fast task can end before `executeTask` hands us the execution object, so
    // match the task itself as well as the tracked execution.
    const isOurs = (candidate: vscode.TaskExecution): boolean => (
      candidate === execution
      || candidate.task === task
      || (execution === undefined && candidate.task.name === title && candidate.task.source === TASK_SOURCE)
    )

    // Attach the listeners BEFORE executing: a task that finished already must
    // resolve this promise instead of leaving the caller waiting forever.
    processEndSub = vscode.tasks.onDidEndTaskProcess((event) => {
      if (!isOurs(event.execution)) return
      settle(event.exitCode === 0)
    })
    taskEndSub = vscode.tasks.onDidEndTask((event) => {
      if (!isOurs(event.execution)) return
      if (taskEndTimer !== undefined) return
      // The process-end event normally arrives first; give it a moment so a
      // normal completion keeps its real exit code instead of failing here.
      taskEndTimer = setTimeout(() => settle(false), TASK_END_GRACE_MS)
    })
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
