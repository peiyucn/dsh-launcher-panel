/**
 * Launching and killing the dsh server process.
 *
 * Two spawn paths exist and the difference is the console on Windows. The
 * server must run inside a *hidden console* (`Start-Process -WindowStyle
 * Hidden`) rather than a console-less child (`windowsHide`), because the tool
 * subprocesses dsh spawns — bash, pwsh — need a console to attach to; without
 * one each of them creates its own visible window. That path then loses the
 * child's pipes, so its output reaches the dashboard through the log file
 * instead (see server/log-tail).
 *
 * This module owns the process registry — the child handle and the pid — since
 * everything that stops or supervises a running server needs exactly those two
 * values and nothing else.
 *
 * @module server/process
 */

import * as vscode from 'vscode'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { DSH_NO_OPEN_MIN_VERSION, dshVersionAtLeast } from '../versions.ts'
import { NODE_PROBE_TIMEOUT_MS, TASKKILL_TIMEOUT_MS } from '../timing.ts'
import { decodeChildOutput, isProcessAlive, psQuote, quoteCmdArg } from '../proc.ts'
import { ensureLogDir, serverLogFile, truncateServerLog } from './activity.ts'
import { startLogTail, type LogTailHost } from './log-tail.ts'

/** What the process layer needs from the lifecycle it runs inside. */
export interface ProcessHost {
  /** Append one server-output line to the activity feed + log file. */
  appendOutput: (line: string) => void
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
 * Spawn the DSH server inside a hidden console on Windows. A hidden console
 * (SW_HIDE via Start-Process -WindowStyle Hidden) lets the tool subprocesses
 * DSH spawns (bash/pwsh) attach to it without flashing their own cmd windows,
 * unlike `windowsHide` (CREATE_NO_WINDOW), which leaves them console-less and
 * forces each child to create a new visible window.
 *
 * The server itself runs as `cmd /c ... > log 2>&1` so output lands in the log
 * file that the tailer streams into the dashboard; Start-Process must NOT use
 * -RedirectStandardOutput/Error, because that keeps the parent PowerShell alive
 * until the child exits (a PowerShell quirk with long-running children).
 * `-PassThru` echoes the cmd.exe PID, which stays alive for the server's
 * lifetime (cmd /c blocks on the server process).
 */
function spawnHiddenViaPowerShell(cmd: string, args: string[], cwd: string | undefined, host: ProcessHost, env?: Record<string, string>): void {
  const program = quoteCmdArg(cmd)
  const rest = args.map(quoteCmdArg).join(' ')
  let run = rest ? `${program} ${rest}` : program
  if (env) {
    // The quoted `set "K=V"` form keeps cmd metacharacters out of the value.
    const setEnv = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join('&& ')
    run = `${setEnv}&& ${run}`
  }
  const inner = `${run} >> ${quoteCmdArg(serverLogFile())} 2>&1`
  const wd = cwd ? `-WorkingDirectory '${psQuote(cwd)}' ` : ''
  const script =
    `$p = Start-Process -FilePath 'cmd.exe' ${wd}-ArgumentList '/d','/s','/c','${psQuote(inner)}' ` +
    `-WindowStyle Hidden -PassThru; Write-Output "DSH_PID=$($p.Id)"`

  startLogTail(host.logTail)

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    // NOTE: no `detached` here — on Windows it breaks powershell's stdio and
    // Start-Process (empirically verified). The server survives regardless,
    // because Start-Process launches it as an independent process.
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.unref()
  trackedChild = child

  let pidBuf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    pidBuf += chunk.toString()
    const m = /DSH_PID=(\d+)/.exec(pidBuf)
    if (m && trackedChild === child) trackedPid = Number(m[1])
  })
  child.stdout?.on('error', () => {})
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) host.addActivity(text)
  })
  child.stderr?.on('error', () => {})

  child.once('error', (error) => {
    // Do not clear trackedChild here: 'close' always follows and owns the
    // cleanup, so its fail-fast below can still observe the child. Clearing
    // early made the close guard dead code and left a dead spawn spinning in
    // waitForPort forever.
    void vscode.window.showErrorMessage(`DeepSeek Harness: failed to start (${error.message}).`)
  })
  // 'close' fires after 'exit' and after stdout is fully delivered; this
  // launcher exits right after Start-Process. If no PID was ever reported,
  // the server never came up — fail the start instead of letting waitForPort
  // spin forever.
  child.once('close', () => {
    if (trackedChild === child) trackedChild = undefined
    if (trackedPid === undefined && host.isStarting()) host.onLaunchFailed()
  })
}

/**
 * Spawn the DSH server with no console window (Windows) and stream its
 * stdout/stderr into the dashboard activity feed + log file.
 */
export function spawnServer(cmd: string, args: string[], cwd: string | undefined, host: ProcessHost, shell = false, env?: Record<string, string>): void {
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
    return
  }
  // Each start gets a fresh server log (dsh.clearServerLogOnStart, default on)
  // — otherwise output from every previous run accumulates (NODE_DEBUG=module
  // alone produced a ~90MB file) and mixes with the current run. Truncation is
  // best effort: a just-stopped server may still hold the file open.
  if (vscode.workspace.getConfiguration('dsh').get<boolean>('clearServerLogOnStart') ?? true) {
    truncateServerLog()
  }

  const hideConsole = vscode.workspace.getConfiguration('dsh').get<boolean>('hideConsole') ?? true

  if (process.platform === 'win32' && hideConsole) {
    spawnHiddenViaPowerShell(cmd, args, cwd, host, env)
    return
  }

  const child = spawn(cmd, args, {
    cwd,
    shell,
    windowsHide: hideConsole,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : undefined,
  })
  child.unref()
  trackedChild = child
  // Mirror the hidden-console path so waitForPort's fail-fast (which checks
  // trackedPid) also covers a directly-spawned child that exits immediately.
  trackedPid = child.pid

  let outBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    outBuffer += chunk.toString()
    const lines = outBuffer.split(/\r?\n/)
    outBuffer = lines.pop() ?? ''
    for (const line of lines) host.appendOutput(line)
  })
  child.stdout?.on('error', () => {})
  let errBuffer = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    errBuffer += chunk.toString()
    const lines = errBuffer.split(/\r?\n/)
    errBuffer = lines.pop() ?? ''
    for (const line of lines) host.appendOutput(line)
  })
  child.stderr?.on('error', () => {})

  child.once('error', (error) => {
    trackedChild = undefined
    void vscode.window.showErrorMessage(`DeepSeek Harness: failed to start (${error.message}).`)
  })
  child.once('exit', () => {
    trackedChild = undefined
  })
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
export function spawnSource(repoPath: string, cfg: { port: number; nodePath: string; sourceDebug: boolean }, version: string, host: ProcessHost): void {
  const node = cfg.nodePath || 'node'
  host.setDshState('ok')
  host.addActivity('✓ dsh detected (source run)')
  host.addActivity('ℹ Source mode compiles TypeScript on the fly with tsx — the first start is slower, please wait')
  const webArgs = buildWebArgs(cfg, version)
  host.setStartBusyId(host.addActivity(`▶ Start: ${node} --import tsx/esm apps/cli/src/bin.ts ${webArgs.join(' ')}`, true))
  const env = cfg.sourceDebug ? { NODE_DEBUG: 'module' } : undefined
  spawnServer(node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...webArgs], repoPath, host, false, env)
}

/** pkg mode: run the managed dsh via `pnpm exec dsh web` (pnpm sets up the module path). */
export function spawnPkg(cfg: { port: number }, pnpmCmd: string, version: string, installDir: string, host: ProcessHost): void {
  host.setDshState('ok')
  host.addActivity('✓ dsh detected (pkg run)')
  const webArgs = buildWebArgs(cfg, version)
  host.setStartBusyId(host.addActivity(`▶ Start: pnpm exec dsh ${webArgs.join(' ')}`, true))
  // verify-deps-before-run=false：安装决定权只在 launcher（首次安装 / Update）。
  // pnpm exec 默认会在依赖状态不一致时自动重跑 pnpm install——那次重装撞上
  // 网络/元数据问题时，会把本可正常运行的已装 dsh 挡在启动之外。
  const execArgs = ['--config.verify-deps-before-run=false', 'exec', 'dsh', ...webArgs]
  if (process.platform === 'win32') {
    // pnpm is a .cmd shim: drive it through cmd with the arguments array, so
    // Windows quoting keeps fallback shim paths (possibly containing spaces)
    // intact in both the hidden-console and the visible-console spawn paths.
    spawnServer('cmd', ['/c', quoteCmdArg(pnpmCmd), ...execArgs], installDir, host, false)
  } else {
    spawnServer(pnpmCmd, execArgs, installDir, host, false)
  }
}

/**
 * Kill one process. On Windows this kills the whole tree: the tracked pid is
 * cmd.exe, and the node child that `cmd /c` blocks on would otherwise survive
 * and finish starting.
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
