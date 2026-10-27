import * as fs from 'node:fs'
import { extractWebToken } from './env.ts'

/** Never read more than the tail: a source-mode log can reach ~90 MB. */
export const LOG_READ_BYTES = 256 * 1024

export const LOG_TAIL_LINES = 200

export function readRange(file: string, start: number, length: number): Buffer | undefined {
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
