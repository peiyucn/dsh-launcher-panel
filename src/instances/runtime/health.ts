import { isProcessAlive, sleep } from '../../shared/proc.ts'
import { HTTP_PROBE_TIMEOUT_MS, PORT_POLL_INTERVAL_MS } from '../../shared/timing.ts'
import { httpOk, isPortOpen, tokenAccepted } from '../../dsh/probes.ts'
import { readLogTail, readTokenFromLog } from '../../shared/logs.ts'
import type { InstanceEvent, InstanceState } from '../state.ts'

const LOOPBACK = '127.0.0.1'

const START_TIMEOUT_MS = 10 * 60_000

export function loopbackUrl(port: number): string {
  return `http://${LOOPBACK}:${port}`
}

export function isListening(port: number, probeMs?: number): Promise<boolean> {
  return isPortOpen(LOOPBACK, port, probeMs)
}

export async function probeUrl(port: number, logPath: string, legacyLogPath: string): Promise<string | undefined> {
  const plain = `${loopbackUrl(port)}/`
  if (await httpOk(plain, HTTP_PROBE_TIMEOUT_MS)) return plain
  const token = readTokenFromLog(logPath) ?? readTokenFromLog(legacyLogPath)
  if (token === undefined) return undefined
  const tokenUrl = `${plain}?token=${token}`
  return (await tokenAccepted(tokenUrl, HTTP_PROBE_TIMEOUT_MS)) ? tokenUrl : undefined
}

export interface AdoptHooks {
  setUrl(url: string): void
  clearError(): void
  clearConsoleLog(): void
  adopt(): void
}

export async function adoptServer(
  port: number,
  logPath: string,
  legacyLogPath: string,
  hooks: AdoptHooks,
): Promise<boolean> {
  const url = await probeUrl(port, logPath, legacyLogPath)
  if (url === undefined) return false
  hooks.setUrl(url)
  hooks.clearError()
  hooks.clearConsoleLog()
  hooks.adopt()
  return true
}

export interface ReadyHooks {
  state(): InstanceState
  pid(): number | undefined
  logPath(): string
  legacyLogPath(): string
  activity(line: string): void
  fail(message: string): false
  transition(event: InstanceEvent): void
  setUrl(url: string): void
  killTracked(): void
}

export async function waitForReady(port: number, hooks: ReadyHooks): Promise<boolean> {
  const startedAt = Date.now()
  for (;;) {
    await sleep(PORT_POLL_INTERVAL_MS)
    if (hooks.state() !== 'starting') return false
    if (Date.now() - startedAt > START_TIMEOUT_MS) {
      hooks.killTracked()
      return hooks.fail(`start timed out after ${Math.round(START_TIMEOUT_MS / 60_000)} minutes`)
    }
    const url = await probeUrl(port, hooks.logPath(), hooks.legacyLogPath())
    if (url !== undefined) {
      if (hooks.state() !== 'starting') return false
      hooks.setUrl(url)
      hooks.transition('ready')
      hooks.activity(`✓ Started ${url.replace(/\?token=.*$/, '')}`)
      return true
    }
    const pid = hooks.pid()
    if (pid !== undefined && !isProcessAlive(pid)) {
      const tail = readLogTail(hooks.logPath(), 5).join(' ')
      return hooks.fail(`exited before opening port${tail ? `: ${tail}` : ''}`)
    }
  }
}
