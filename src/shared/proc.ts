import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'

interface RunFileResult {
  ok: boolean
  stdout: string
  stderr: string
  code?: number
  timedOut?: boolean
  error?: string
}

// Node decodes child output as UTF-8, but Windows console tools answer in the OEM code page (GBK on zh-CN).
export function decodeChildOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }
}

export function runFile(command: string, args: string[], timeoutMs = 0): Promise<RunFileResult> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs > 0 ? timeoutMs : undefined, encoding: 'buffer' }, (error, stdout, stderr) => {
      const out = decodeChildOutput(stdout ?? Buffer.alloc(0))
      const err = decodeChildOutput(stderr ?? Buffer.alloc(0))
      if (!error) {
        resolve({ ok: true, stdout: out, stderr: err })
        return
      }
      // execFile reports a timeout as killed + SIGTERM with a null code.
      const timedOut = (error as { killed?: boolean }).killed === true
      const code = typeof error.code === 'number' ? error.code : undefined
      const detail = err.trim().split(/\r?\n/).filter(line => line.trim() !== '').pop()?.trim()
      resolve({
        ok: false,
        stdout: out,
        stderr: err,
        ...(code === undefined ? {} : { code }),
        ...(timedOut ? { timedOut } : {}),
        error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : detail || error.message,
      })
    })
  })
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ResolvedCommand {
  file: string
  args: string[]
}

type CommandResolution =
  | { ok: true; command: ResolvedCommand }
  | { ok: false; reason: string }

// Batch shims spell their own directory as %dp0% (npm) or %~dp0 (corepack and hand-written shims).
function expandShimDir(text: string, dir: string): string {
  return text.replace(/%~?dp0%?/gi, dir)
}

// Quoted and bare target spellings both occur in real shims.
function shimCandidates(text: string, pattern: string): string[] {
  const candidates: string[] = []
  for (const match of text.matchAll(new RegExp(`["']([^"'\\r\\n]+?\\.(?:${pattern}))["']`, 'gi'))) {
    candidates.push(match[1])
  }
  for (const match of text.matchAll(new RegExp(`(?:^|[\\s=])([^\\s"'<>|&]+?\\.(?:${pattern}))(?=$|[\\s])`, 'gim'))) {
    if (!candidates.includes(match[1])) candidates.push(match[1])
  }
  return candidates
}

// Node cannot spawn .cmd/.bat (CVE-2024-27980) and a shell would re-parse the arguments,
// so the shim is read and its target is run directly.
export function resolveCommandEntry(command: string): CommandResolution {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { ok: true, command: { file: command, args: [] } }
  }
  let text: string
  try {
    text = fs.readFileSync(command, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return { ok: false, reason: 'the shim could not be read' }
  }
  const dir = path.dirname(command)
  const resolveAll = (candidates: string[]): string[] =>
    candidates.map((candidate) => path.resolve(dir, expandShimDir(candidate, dir)))
  const pick = (candidates: string[]): string | undefined => candidates.find((entry) => fs.existsSync(entry))
  const scripts = resolveAll(shimCandidates(text, 'mjs|cjs|js'))
  const programs = resolveAll(shimCandidates(text, 'exe|com'))

  // A script runs with the current Node; an interpreter named alongside it is not the entry.
  if (scripts.length > 0) {
    const script = pick(scripts)
    if (script === undefined) {
      return { ok: false, reason: `the shim names ${scripts[scripts.length - 1]}, which does not exist` }
    }
    return { ok: true, command: { file: process.execPath, args: [script] } }
  }
  if (programs.length > 0) {
    const program = pick(programs)
    if (program === undefined) {
      return { ok: false, reason: `the shim names ${programs[programs.length - 1]}, which does not exist` }
    }
    return { ok: true, command: { file: program, args: [] } }
  }
  return { ok: false, reason: 'the shim names no program to run (.js, .cjs, .mjs, .exe or .com)' }
}

export function resolveCommand(command: string): ResolvedCommand | undefined {
  const resolution = resolveCommandEntry(command)
  return resolution.ok ? resolution.command : undefined
}

export function runResolved(command: string, args: string[], timeoutMs = 0): Promise<RunFileResult> {
  const resolution = resolveCommandEntry(command)
  if (!resolution.ok) {
    // An unresolvable shim and an unreachable registry need different advice, so keep the reason.
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      error: `${command} is a Windows batch shim whose target could not be resolved (${resolution.reason})`,
    })
  }
  return runFile(resolution.command.file, [...resolution.command.args, ...args], timeoutMs)
}
