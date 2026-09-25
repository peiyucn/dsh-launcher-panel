/**
 * Subprocess primitives: run a command, read its output, and quote arguments.
 *
 * Output is captured as bytes and decoded here rather than by Node, because
 * Windows console tools answer in the console code page instead of UTF-8.
 *
 * @module proc
 */

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

/** Quote a single token for cmd.exe (only when it contains special characters). */
export function quoteCmdArg(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg
}

/** Escape a value for a PowerShell single-quoted string literal ('' doubles a quote). */
export function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}
