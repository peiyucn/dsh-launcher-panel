import { execFile } from 'node:child_process'
import { NODE_PROBE_TIMEOUT_MS, TASKKILL_TIMEOUT_MS } from '../../shared/timing.ts'
import { decodeChildOutput } from '../../shared/proc.ts'

function execText(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? undefined : stdout)
    })
  })
}

export function killPid(pid: number, dbg: (line: string) => void): void {
  if (process.platform === 'win32') {
    // encoding: 'buffer' preserves taskkill's localized (e.g. GBK) message.
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true, timeout: TASKKILL_TIMEOUT_MS, encoding: 'buffer',
    }, (error, _stdout, stderr) => {
      if (!error) return
      const detail = decodeChildOutput(stderr ?? Buffer.alloc(0)).trim().split(/\r?\n/).filter((line) => line.trim() !== '').join(' ')
      dbg(`taskkill ${pid} failed: ${detail || error.message}`)
    })
    return
  }
  // POSIX: kill the whole group (detached spawn) so pnpm/node descendants release the port.
  try {
    process.kill(-pid)
    return
  } catch {
    // Not a group leader; fall back to the single pid.
  }
  try {
    process.kill(pid)
  } catch {
    // Already exited.
  }
}

export async function findPortOwner(port: number): Promise<number | undefined> {
  if (process.platform !== 'win32') {
    const output = await execText('lsof', ['-ti', `tcp:${port}`], NODE_PROBE_TIMEOUT_MS)
    if (output === undefined) return undefined
    const pid = Number(output.trim().split(/\r?\n/)[0])
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  }
  const output = await execText('netstat', ['-ano'], NODE_PROBE_TIMEOUT_MS)
  if (output === undefined) return undefined
  const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`)
  for (const line of output.split(/\r?\n/)) {
    const match = re.exec(line)
    if (match) return Number(match[1])
  }
  return undefined
}
