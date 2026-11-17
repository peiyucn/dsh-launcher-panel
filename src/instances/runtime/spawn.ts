import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SpawnSpec } from '../../dsh/start-spec.ts'
import type { InstanceState } from '../state.ts'

export interface SpawnHooks {
  state(): InstanceState
  logPath(): string
  clearServerLogOnStart(): boolean
  hideConsole(): boolean
  fail(message: string): false
  setChild(child: ChildProcess | undefined): void
  setPid(pid: number | undefined): void
  handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void
  startLogPump(offset: number): void
}

export function spawnServer(spec: SpawnSpec, hooks: SpawnHooks): boolean {
  try {
    fs.mkdirSync(path.dirname(hooks.logPath()), { recursive: true })
  } catch (error) {
    return hooks.fail(`cannot create the instance log directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (hooks.clearServerLogOnStart()) {
    try { fs.writeFileSync(hooks.logPath(), '') } catch {  }
  }
  let logFd: number
  let startOffset: number
  try {
    logFd = fs.openSync(hooks.logPath(), 'a')

    startOffset = fs.fstatSync(logFd).size
  } catch (error) {
    return hooks.fail(`cannot open the instance log: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: hooks.hideConsole(),

      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    hooks.setChild(child)
    hooks.setPid(child.pid)
    child.unref()
    child.once('error', (error) => {
      if (hooks.state() === 'starting') hooks.fail(`failed to start: ${error.message}`)
    })
    child.once('close', (code, signal) => {
      hooks.setChild(undefined)

      if (hooks.state() === 'running') hooks.handleUnexpectedExit(code, signal)
    })
  } catch (error) {
    return hooks.fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try { fs.closeSync(logFd) } catch {  }
  }
  hooks.startLogPump(startOffset)
  return true
}
