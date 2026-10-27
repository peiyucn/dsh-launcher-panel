import * as fs from 'node:fs'
import { extractWebToken } from '../env.ts'
import { LOG_TAIL_POLL_MS } from '../timing.ts'

/** Never read more than the tail: a source-mode log can reach ~90 MB. */
export const LOG_READ_BYTES = 256 * 1024

export const LOG_TAIL_LINES = 200

/** Lines the live buffer keeps before dropping the oldest. */
const LOG_BUFFER_LINES = 500

function readRange(file: string, start: number, length: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Bounded tail of a file as text; a cut mid-line leaves a partial first line. */
export function readLogTailBytes(file: string, maxBytes = LOG_READ_BYTES): string | undefined {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    return readRange(file, start, stat.size - start)?.toString('utf8')
  } catch {
    return undefined
  }
}

export function readLogTail(file: string, maxLines = LOG_TAIL_LINES): string[] {
  const text = readLogTailBytes(file)
  if (text === undefined) return []
  return text.split(/\r?\n/).filter((line) => line.length > 0).slice(-maxLines)
}

export function readTokenFromLog(file: string): string | undefined {
  const text = readLogTailBytes(file)
  if (text === undefined) return undefined
  let token: string | undefined
  // The newest start printed the token that is valid now.
  for (const line of text.split(/\r?\n/)) token = extractWebToken(line) ?? token
  return token
}

/**
 * Live tail of one instance log. The source path is re-resolved on every pump
 * because an adopted default instance can switch to the legacy log mid-run.
 */
export class LogTailPump {
  private buffer = ''
  private offset = 0
  private lines: string[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private watcher: fs.FSWatcher | undefined
  private sourcePath = ''

  private readonly resolveSource: () => string

  constructor(resolveSource: () => string) {
    this.resolveSource = resolveSource
  }

  start(): void {
    this.stop()
    this.buffer = ''
    this.lines = []
    this.sourcePath = this.resolveSource()
    this.offset = Math.max(0, (this.stat(this.sourcePath)?.size ?? 0) - LOG_READ_BYTES)
    this.pump()
    try {
      this.watcher = fs.watch(this.sourcePath, () => this.pump())
      this.watcher.on('error', () => {})
    } catch {
      this.watcher = undefined
    }
    this.timer = setInterval(() => this.pump(), LOG_TAIL_POLL_MS)
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.watcher?.close()
    this.watcher = undefined
  }

  reset(): void {
    this.stop()
    this.buffer = ''
    this.offset = 0
    this.lines = []
    this.sourcePath = ''
  }

  tail(maxLines: number): string[] {
    return this.lines.slice(-maxLines)
  }

  private stat(file: string): fs.Stats | undefined {
    try {
      return fs.statSync(file)
    } catch {
      return undefined
    }
  }

  private pump(): void {
    const source = this.resolveSource()
    if (source !== this.sourcePath) {
      this.sourcePath = source
      this.offset = 0
      this.buffer = ''
      this.lines = []
    }
    const stat = this.stat(source)
    if (stat === undefined) return
    if (stat.size < this.offset) this.offset = 0
    if (stat.size <= this.offset) return
    const chunk = readRange(source, this.offset, stat.size - this.offset)
    if (chunk === undefined) return
    this.offset += chunk.length
    this.buffer += chunk.toString('utf8')
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) if (line.length > 0) this.lines.push(line)
    const overflow = this.lines.length - LOG_BUFFER_LINES
    if (overflow > 0) this.lines.splice(0, overflow)
  }
}
