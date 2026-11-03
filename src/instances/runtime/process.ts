import { execFile } from 'node:child_process'
import { TASKKILL_TIMEOUT_MS } from '../../shared/timing.ts'
import { decodeChildOutput } from '../../shared/proc.ts'

/**
 * Kill one process tree. Resolves after `taskkill` exits (Windows) or the signal is sent, so
 * the caller can wait for the port to close instead of racing a fire-and-forget kill.
 */
export function killPid(pid: number, dbg: (line: string) => void): Promise<boolean> {
  // Never let a bad lookup (e.g. the PID 0 a socket table may report) terminate the launcher
  // itself or a kernel process.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    dbg(`refused to kill invalid pid ${pid}`)
    return Promise.resolve(false)
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      // encoding: 'buffer' preserves taskkill's localized (e.g. GBK) message.
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true, timeout: TASKKILL_TIMEOUT_MS, encoding: 'buffer',
      }, (error, _stdout, stderr) => {
        if (!error) {
          resolve(true)
          return
        }
        const detail = decodeChildOutput(stderr ?? Buffer.alloc(0)).trim().split(/\r?\n/).filter((line) => line.trim() !== '').join(' ')
        dbg(`taskkill ${pid} failed: ${detail || error.message}`)
        resolve(false)
      })
    })
  }
  // POSIX: kill the whole group (detached spawn) so pnpm/node descendants release the port.
  try {
    process.kill(-pid)
    return Promise.resolve(true)
  } catch {
    // Not a group leader; fall back to the single pid.
  }
  try {
    process.kill(pid)
    return Promise.resolve(true)
  } catch {
    // Already exited.
    return Promise.resolve(false)
  }
}
