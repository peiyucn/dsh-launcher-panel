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
 * @module server/terminal
 */

import * as vscode from 'vscode'

/** What the terminal layer needs from the lifecycle it runs inside. */
export interface TerminalHost {
  /** Report into the panel feed; returns the entry id. */
  addActivity: (line: string, isBusy?: boolean) => number
}

/**
 * Run a command in a visible VS Code terminal.
 *
 * `env` entries are merged into the terminal process environment, which is how
 * the source-mode build requests dsh's official client profile.
 *
 * @returns true when the command exited 0.
 */
export async function runInTerminal(
  title: string, command: string, args: string[], host: TerminalHost, env?: Record<string, string>,
): Promise<boolean> {
  const task = new vscode.Task(
    { type: 'dsh-shell' },
    vscode.TaskScope.Global,
    title,
    'DeepSeek Harness',
    new vscode.ShellExecution(command, args, env ? { env } : undefined),
  )
  return new Promise<boolean>((resolve) => {
    let execution: vscode.TaskExecution | undefined
    // Attach the end listener BEFORE executing: a task that finished before
    // the listener would never resolve this promise, leaving the start flow
    // (and the busy coalescing lock) hanging forever.
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (execution !== undefined && event.execution === execution) {
        disposable.dispose()
        resolve(event.exitCode === 0)
      }
    })
    void vscode.tasks.executeTask(task).then((ex) => {
      execution = ex
    }, () => {
      disposable.dispose()
      host.addActivity(`✗ could not run "${title}" in a terminal`)
      resolve(false)
    })
  })
}
