/**
 * Launching and killing the dsh server process.
 *
 * **Why there is no shell here.** The server is launched with Node's own
 * `spawn(file, argsArray)`, which quotes arguments by the MSVCRT rule. Nothing
 * is ever concatenated into a command line, so a value from a setting (a Node
 * path, a package dir) is data — it cannot become a second command. An earlier
 * version built a `cmd /c …` line inside a PowerShell `Start-Process`, which
 * both broke on paths containing spaces and let a crafted `dsh.nodePath` inject
 * a command. Two facts make that whole approach unnecessary:
 *
 * - `windowsHide: true` gives the child a console whose window is hidden, which
 *   is all dsh's own tool subprocesses (bash, pwsh) need to attach to instead of
 *   each flashing a window. This is the same choice dsh itself makes for its
 *   ordinary subprocesses (`packages/subprocess/subprocess-local/src/spawn.ts`
 *   passes `windowsHide: platform === 'win32'`), and its Win32 path documents
 *   why it does *not* use `CREATE_NO_WINDOW`: that flag can break console
 *   inheritance (`packages/subprocess/win32-process/src/process.ts`).
 * - Output goes straight to the log file through `stdio: ['ignore', fd, fd]`,
 *   which replaces what `>> log 2>&1` used to do without a shell.
 *
 * The one case a shell used to cover is a `.cmd` shim (`pnpm`): Node refuses to
 * spawn a `.cmd`/`.bat` directly (an `EINVAL` guard added for CVE-2024-27980),
 * and `shell: true` would reintroduce exactly the injection this module avoids.
 * Those shims are Node wrappers, so {@link resolveNodeEntry} reads the shim and
 * runs its target with the current Node instead.
 *
 * This module owns the process registry — the child handle and the pid — since
 * everything that stops or supervises a running server needs exactly those two
 * values and nothing else.
 *
 * @module server/process
 */

import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { DSH_NO_OPEN_MIN_VERSION, dshVersionAtLeast } from '../versions.ts'
import { NODE_PROBE_TIMEOUT_MS, TASKKILL_TIMEOUT_MS } from '../timing.ts'
import { decodeChildOutput, isProcessAlive, resolveCommand } from '../proc.ts'
import { ensureLogDir, serverLogFile, truncateServerLog } from './activity.ts'
import { startLogTail, type LogTailHost } from './log-tail.ts'

/** What the process layer needs from the lifecycle it runs inside. */
export interface ProcessHost {
  /** Report into the panel feed; returns the entry id. */
  addActivity: (line: string, isBusy?: boolean) => number
  /** Record dsh availability for the status line. */
  setDshState: (state: 'unknown' | 'ok' | 'missing') => void
  /** Remember the id of the "starting" spinner so a later step can clear it. */
  setStartBusyId: (id: number) => void
  /** Drop the cached web token: each run mints its own. */
  clearWebToken: () => void
  /**
   * Zero the per-run output counters. Must run when a spawn begins: the
   * silent-exit diagnosis reads "0 lines seen" to mean "the child died without
   * printing anything", so counters that survive into the next run suppress
   * that diagnosis for every later failure.
   */
  resetRunCounters: () => void
  /** The phase is 'starting' while a spawn is being supervised. */
  isStarting: () => boolean
  /** The start failed before a process id was ever reported. */
  onLaunchFailed: () => void
  /** The log tailer's host (path + sink). */
  logTail: LogTailHost
  /** Diagnostic line to the log file only. */
  dbg: (line: string) => void
}

/** The spawned child, kept so a stop can kill the tree it belongs to. */
let trackedChild: ChildProcess | undefined
/** The pid that actually serves the web UI (behind cmd.exe on Windows). */
let trackedPid: number | undefined

/** The pid of the process serving the web UI, when one was reported. */
export function getTrackedPid(): number | undefined {
  return trackedPid
}

/** Move the tracked child/pid out of the registry for one teardown pass. */
export function takeTracked(): { child: ChildProcess | undefined; pid: number | undefined } {
  const taken = { child: trackedChild, pid: trackedPid }
  trackedChild = undefined
  trackedPid = undefined
  return taken
}

/**
 * Spawn the DSH server: no console window, output appended to the server log.
 *
 * Arguments are passed as an array, so nothing is parsed by a shell and a value
 * from a setting can only ever be one argument. `windowsHide` keeps the console
 * window hidden while still giving the child a console for its own tool
 * subprocesses to inherit; `stdio` points straight at the log file, which is
 * what the tailer streams into the dashboard.
 *
 * @returns whether a process was actually started. The caller must not wait for
 *   a port when this is false: nothing was spawned, so no port will ever open,
 *   and `waitForPort` has no other way to tell "not started yet" from "never
 *   will be" — it would poll until the user pressed Stop.
 */
export function spawnServer(cmd: string, args: string[], cwd: string | undefined, host: ProcessHost, env?: Record<string, string>): boolean {
  trackedPid = undefined
  host.clearWebToken()
  // Counters are per run: the silent-exit diagnosis treats "0 lines" as "died
  // without printing anything", so they must restart here (v0.2.12 did this
  // inline; the extraction dropped it once already — see the host field).
  host.resetRunCounters()
  const logDir = ensureLogDir()
  if (!logDir.ok) {
    // Failing here used to escape as an unhandled rejection from the Start
    // command; report it and abort the spawn instead.
    host.addActivity('✗ Could not create the log folder — check write permissions under your home directory')
    void vscode.window.showErrorMessage(`DeepSeek Harness: could not create ${logDir.dir}. Check write permissions.`)
    host.onLaunchFailed()
    return false
  }
  // Each start gets a fresh server log (dsh.clearServerLogOnStart, default on)
  // — otherwise output from every previous run accumulates (NODE_DEBUG=module
  // alone produced a ~90MB file) and mixes with the current run. Truncation is
  // best effort: a just-stopped server may still hold the file open.
  if (vscode.workspace.getConfiguration('dsh').get<boolean>('clearServerLogOnStart') ?? true) {
    truncateServerLog()
  }

  const hideConsole = vscode.workspace.getConfiguration('dsh').get<boolean>('hideConsole') ?? true

  // The tailer follows the log file; start it before the child can write.
  startLogTail(host.logTail)

  let logFd: number
  try {
    logFd = fs.openSync(serverLogFile(), 'a')
  } catch (error) {
    host.addActivity(`✗ Could not open the server log for writing — ${error instanceof Error ? error.message : String(error)}`)
    host.onLaunchFailed()
    return false
  }

  let child: ChildProcess
  try {
    child = spawn(cmd, args, {
      cwd,
      windowsHide: hideConsole,
      // POSIX: detached makes the child a group leader so Stop can signal the
      // whole tree. On Windows it must stay off: `detached` sets
      // DETACHED_PROCESS, which drops the console entirely (and makes
      // windowsHide's CREATE_NO_WINDOW be ignored), so dsh's own bash/pwsh
      // would each get a *visible* window — the opposite of the point.
      detached: process.platform !== 'win32',
      stdio: ['ignore', logFd, logFd],
      env: env ? { ...process.env, ...env } : undefined,
    })
  } catch (error) {
    // spawn throws synchronously for a few inputs (notably `.cmd`/`.bat`);
    // report it rather than letting it unwind the caller's start flow.
    fs.closeSync(logFd)
    host.addActivity(`✗ Could not start ${cmd} — ${error instanceof Error ? error.message : String(error)}`)
    host.onLaunchFailed()
    return false
  } finally {
    // The child holds its own duplicate; ours is only needed to create it.
    try { fs.closeSync(logFd) } catch { /* already closed above */ }
  }

  child.unref()
  trackedChild = child
  // The real pid, taken from Node rather than parsed out of a launcher's
  // stdout — and undefined (not a placeholder) when the OS refused the spawn,
  // which is what waitForPort's fail-fast reads.
  trackedPid = child.pid

  child.once('error', (error) => {
    // Do not clear trackedChild here: 'close' always follows and owns the
    // cleanup, so its fail-fast below can still observe the child. Clearing
    // early made the close guard dead code and left a dead spawn spinning in
    // waitForPort forever.
    void vscode.window.showErrorMessage(`DeepSeek Harness: failed to start (${error.message}).`)
  })
  child.once('close', () => {
    if (trackedChild === child) trackedChild = undefined
    // No pid means the OS never started it (e.g. ENOENT). waitForPort's own
    // fail-fast cannot fire on `pid === undefined`, so fail the start here.
    if (trackedPid === undefined && host.isStarting()) host.onLaunchFailed()
  })
  return true
}

/**
 * The `web` command tail: the port, plus `--no-open` when dsh ≥ rc.8 would
 * open the system browser on its own. `version` is the exact version about
 * to run — passed explicitly because the detected version is recomputed by
 * status refreshes and can be empty mid-install.
 */
export function buildWebArgs(cfg: { port: number }, version: string): string[] {
  const args = ['web', '--port', String(cfg.port)]
  if (version && dshVersionAtLeast(version, DSH_NO_OPEN_MIN_VERSION)) args.push('--no-open')
  return args
}

/** Source mode: run a checkout via `node --import tsx/esm apps/cli/src/bin.ts web`. */
export function spawnSource(repoPath: string, cfg: { port: number; nodePath: string; sourceDebug: boolean }, version: string, host: ProcessHost): boolean {
  const node = cfg.nodePath || 'node'
  host.setDshState('ok')
  host.addActivity('✓ dsh detected (source run)')
  host.addActivity('ℹ Source mode compiles TypeScript on the fly with tsx — the first start is slower, please wait')
  const webArgs = buildWebArgs(cfg, version)
  host.setStartBusyId(host.addActivity(`▶ Start: ${node} --import tsx/esm apps/cli/src/bin.ts ${webArgs.join(' ')}`, true))
  const env = cfg.sourceDebug ? { NODE_DEBUG: 'module' } : undefined
  return spawnServer(node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...webArgs], repoPath, host, env)
}

/** pkg mode: run the managed dsh via `pnpm exec dsh web` (pnpm sets up the module path). */
export function spawnPkg(cfg: { port: number }, pnpmCmd: string, version: string, installDir: string, host: ProcessHost): boolean {
  host.setDshState('ok')
  host.addActivity('✓ dsh detected (pkg run)')
  const webArgs = buildWebArgs(cfg, version)
  host.setStartBusyId(host.addActivity(`▶ Start: pnpm exec dsh ${webArgs.join(' ')}`, true))
  // verify-deps-before-run=false：安装决定权只在 launcher（首次安装 / Update）。
  // pnpm exec 默认会在依赖状态不一致时自动重跑 pnpm install——那次重装撞上
  // 网络/元数据问题时，会把本可正常运行的已装 dsh 挡在启动之外。
  const execArgs = ['--config.verify-deps-before-run=false', 'exec', 'dsh', ...webArgs]
  // On Windows `pnpm` is a `.cmd` shim, which Node refuses to spawn directly, so
  // run the Node script that shim wraps (see resolveCommand).
  const resolved = resolveCommand(pnpmCmd)
  if (resolved === undefined) {
    host.addActivity(`✗ ${pnpmCmd} is a Windows batch shim whose Node entry could not be resolved — install pnpm with npm and try again`)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${pnpmCmd} cannot be launched safely. Install pnpm with npm and try again.`)
    host.onLaunchFailed()
    return false
  }
  return spawnServer(resolved.file, [...resolved.args, ...execArgs], installDir, host)
}

/**
 * Kill one process. On Windows the whole tree is killed: the tracked pid is the
 * server's own Node process, and the tool subprocesses it spawned (bash, pwsh,
 * pnpm) are its descendants — `/T` takes them with it.
 *
 * `taskkill` answers in the system code page (GBK on a Chinese Windows), so its
 * stderr is decoded explicitly — reading `error.message` would yield the
 * already-lossy UTF-8 reading, which is where `????` in the activity log came
 * from. Killing a pid that has already exited is normal teardown, so the text
 * has to stay legible.
 */
export function killPid(pid: number, dbg: (line: string) => void): void {
  if (process.platform === 'win32') {
    // Taskkill output is captured as bytes so a localized message survives.
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true, timeout: TASKKILL_TIMEOUT_MS, encoding: 'buffer',
    }, (error, _stdout, stderr) => {
      if (!error) return
      const detail = decodeChildOutput(stderr ?? Buffer.alloc(0)).trim().split(/\r?\n/).filter(line => line.trim() !== '').join(' ')
      dbg(`taskkill ${pid} failed: ${detail || error.message}`)
    })
    return
  }
  // POSIX: the spawned process is a group leader (detached spawn), so kill the
  // whole group first — pnpm → node children would otherwise survive and keep
  // holding the port. Fall back to the single pid when the group is gone.
  try {
    process.kill(-pid)
  } catch {
    try {
      process.kill(pid)
    } catch {
      // Process already exited.
    }
  }
}

/** PID of the process listening on `port`, if any. Windows uses netstat, POSIX uses lsof. */
export async function findPortOwner(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('netstat', ['-ano'], { windowsHide: true, timeout: NODE_PROBE_TIMEOUT_MS }, (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`)
        for (const line of stdout.split(/\r?\n/)) {
          const match = re.exec(line)
          if (match) {
            resolve(Number(match[1]))
            return
          }
        }
        resolve(undefined)
      })
    })
  }
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${port}`], { windowsHide: true, timeout: NODE_PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      const pid = Number(stdout.trim().split(/\r?\n/)[0])
      resolve(Number.isFinite(pid) && pid > 0 ? pid : undefined)
    })
  })
}

/** Whether a process id is still alive (re-exported so callers need one import). */
export { isProcessAlive }
