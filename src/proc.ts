/**
 * Subprocess primitives: run a command, read its output, and resolve Windows
 * shims.
 *
 * Output is captured as bytes and decoded here rather than by Node, because
 * Windows console tools answer in the console code page instead of UTF-8.
 *
 * @module proc
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'

/** The outcome of a {@link runFile} call. */
export interface RunFileResult {
  ok: boolean
  stdout: string
  stderr: string
  /**
   * Process exit code when the command ran and exited non-zero; undefined on
   * success, on a spawn failure (`ENOENT` etc.), and on a timeout kill — those
   * set {@link error} instead.
   */
  code?: number
  /** The bound elapsed before the command finished (it was killed). */
  timedOut?: boolean
  /** A one-line reason suitable for an activity entry; undefined on success. */
  error?: string
}

/**
 * Decode one child-process output buffer.
 *
 * Node decodes child stdout/stderr as UTF-8 unconditionally, but Windows console
 * tools answer in the console code page: `taskkill` on a Chinese Windows emits
 * GBK, so every one of its bytes becomes U+FFFD and the activity log fills with
 * `????`. Decode strictly as UTF-8 first — a tool that does speak UTF-8 must
 * never be reinterpreted — and fall back to the legacy code page only when the
 * bytes are not valid UTF-8. A Node built with small-icu has no legacy decoder,
 * in which case the lossy UTF-8 reading is all that is available.
 * @param buf - raw stdout or stderr bytes from a child process.
 * @returns the best available reading of those bytes.
 */
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

/**
 * Run one external command without a shell (no cmd window flash on Windows);
 * `timeoutMs` bounds a hung probe (`0` means no bound, which callers choose
 * deliberately for work they expect to run long). Output is captured as bytes
 * and decoded by {@link decodeChildOutput}, so a console tool answering in the
 * system code page still reaches the activity log as readable text.
 *
 * Failures keep enough shape to report *why* — a timeout ("took too long") and a
 * non-zero exit ("fatal: …") are different problems for the user, and collapsing
 * both into `ok: false` is what made update failures undiagnosable.
 */
export function runFile(command: string, args: string[], timeoutMs = 0): Promise<RunFileResult> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs > 0 ? timeoutMs : undefined, encoding: 'buffer' }, (error, stdout, stderr) => {
      const out = decodeChildOutput(stdout ?? Buffer.alloc(0))
      const err = decodeChildOutput(stderr ?? Buffer.alloc(0))
      if (!error) {
        resolve({ ok: true, stdout: out, stderr: err })
        return
      }
      // execFile kills on timeout: error.killed + SIGTERM, with a null code.
      const timedOut = (error as { killed?: boolean }).killed === true
      const code = typeof error.code === 'number' ? error.code : undefined
      const detail = err.trim().split(/\r?\n/).filter(line => line.trim() !== '').pop()?.trim()
      resolve({
        ok: false,
        stdout: out,
        stderr: err,
        // Absent rather than false: these are "why it failed" fields, and a
        // success-shaped `timedOut: false` only invites truthiness bugs.
        ...(code === undefined ? {} : { code }),
        ...(timedOut ? { timedOut } : {}),
        error: timedOut
          ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : detail || error.message,
      })
    })
  })
}

/** Whether a process id is still alive. */
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

/** One command that can be spawned directly, without a shell. */
export interface ResolvedCommand {
  file: string
  args: string[]
}

/** The outcome of turning a batch shim into a direct command. */
export type CommandResolution =
  | { ok: true; command: ResolvedCommand }
  | { ok: false; reason: string }

/**
 * Expand the "directory this shim lives in" placeholders batch shims use:
 * `%dp0%` (npm's cmd-shim) and `%~dp0` (corepack and hand-written shims).
 */
function expandShimDir(text: string, dir: string): string {
  return text.replace(/%~?dp0%?/gi, dir)
}

/**
 * The paths a shim names, split by how they must be launched.
 *
 * A shim either runs a **script** through an interpreter (`node "…\pnpm.cjs"`,
 * `"…\node.exe" "…\pnpm.mjs"`) or runs a **program** directly
 * (`"%dp0%\node_modules\pnpm\pnpm.exe"`). Both are normal: pnpm ships a Windows
 * executable in its npm package, and its npm shim points straight at it.
 *
 * Both quoting styles are accepted: npm's cmd-shim quotes the path, while
 * corepack-style and hand-written shims may leave it bare.
 */
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

/**
 * Resolve a batch shim's target, reporting why when it cannot be found.
 *
 * Node's `spawn` refuses to run a `.cmd`/`.bat` (its CVE-2024-27980 guard) and
 * handing the shim to a shell would let an argument become a second command, so
 * the shim is read and what it wraps is run directly instead — the arguments
 * then stay arguments:
 *
 * - a script (`.js`/`.cjs`/`.mjs`) runs with the current Node;
 * - a program (`.exe`/`.com`) is spawned as-is.
 *
 * A script always wins over an interpreter named elsewhere in the same shim
 * (corepack's `"%~dp0\node.exe" "…\corepack.js"`), and the paths are accepted
 * quoted or bare, absolute or built from the shim's own directory, because real
 * installations write all of those shapes.
 */
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
  const scripts = resolveAll(shimCandidates(text, 'mjs|cjs|js'))
  const programs = resolveAll(shimCandidates(text, 'exe|com'))

  // A script runs with Node; an interpreter named alongside it is not the entry.
  if (scripts.length > 0) {
    const script = scripts.find((entry) => fs.existsSync(entry))
    if (script === undefined) {
      return { ok: false, reason: `the shim names ${scripts[scripts.length - 1]}, which does not exist` }
    }
    return { ok: true, command: { file: process.execPath, args: [script] } }
  }
  if (programs.length > 0) {
    const program = programs.find((entry) => fs.existsSync(entry))
    if (program === undefined) {
      return { ok: false, reason: `the shim names ${programs[programs.length - 1]}, which does not exist` }
    }
    return { ok: true, command: { file: program, args: [] } }
  }
  return { ok: false, reason: 'the shim names no program to run (.js, .cjs, .mjs, .exe or .com)' }
}

/**
 * How to invoke a command that may be a Windows batch shim.
 *
 * @param command - a resolved pnpm path (`…\pnpm.cmd`) or any executable.
 * @returns the executable and leading arguments to use, or undefined when the
 *   command is a batch file whose target could not be determined — the caller
 *   must then report rather than spawn something that cannot work.
 */
export function resolveCommand(command: string): ResolvedCommand | undefined {
  const resolution = resolveCommandEntry(command)
  return resolution.ok ? resolution.command : undefined
}

/**
 * Run a command, transparently resolving a Windows batch shim first.
 *
 * This is the shell-free equivalent of the old `cmd /c <shim> …` calls: the
 * shim's target (its Node script or the program it points at) is executed
 * directly, so a path containing spaces works and no argument can be
 * reinterpreted as a second command.
 *
 * @param command - pnpm (possibly a `.cmd` shim) or any executable.
 * @param args - arguments, passed as an array.
 * @param timeoutMs - the bound for the whole call; 0 or less disables it.
 * @returns the same shape as {@link runFile}, with a resolution failure reported
 *   as `ok: false` rather than thrown.
 */
export function runResolved(command: string, args: string[], timeoutMs = 0): Promise<RunFileResult> {
  const resolution = resolveCommandEntry(command)
  if (!resolution.ok) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      // Keep the reason: "unresolvable shim" and "registry unreachable" are
      // different problems, and only one of them is worth retrying later.
      error: `${command} is a Windows batch shim whose target could not be resolved (${resolution.reason})`,
    })
  }
  return runFile(resolution.command.file, [...resolution.command.args, ...args], timeoutMs)
}
