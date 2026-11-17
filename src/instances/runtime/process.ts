import { execFile } from 'node:child_process'
import { TASKKILL_TIMEOUT_MS } from '../../shared/timing.ts'
import { decodeChildOutput } from '../../shared/proc.ts'

export function killPid(pid: number, dbg: (line: string) => void): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    dbg(`refused to kill invalid pid ${pid}`)
    return Promise.resolve(false)
  }
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
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

  try {
    process.kill(-pid)
    return Promise.resolve(true)
  } catch {
  }
  try {
    process.kill(pid)
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(false)
  }
}
