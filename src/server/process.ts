/**
 * Killing a dsh process and finding the process that owns a port.
 *
 * **Why there is no shell here.** Processes are launched from
 * `server/instance-runtime.ts` with Node's own `spawn(file, argsArray)`, which
 * quotes arguments by the MSVCRT rule. Nothing is ever concatenated into a
 * command line, so a value from a setting (a Node path, a package dir) is data —
 * it cannot become a second command. An earlier version built a `cmd /c …` line
 * inside a PowerShell `Start-Process`, which both broke on paths containing
 * spaces and let a crafted `dsh.nodePath` inject a command. This module only
 * tears down what that layer started.
 *
 * @module server/process
 */

import { execFile } from 'node:child_process'
import { NODE_PROBE_TIMEOUT_MS, TASKKILL_TIMEOUT_MS } from '../timing.ts'
import { decodeChildOutput } from '../proc.ts'

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
