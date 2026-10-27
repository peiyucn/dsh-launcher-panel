/**
 * Bounded reads of an instance server log.
 *
 * The launcher only ever needs the tail of a log: the last console lines and the
 * newest launch token. Reading the whole file would block the extension host on
 * the very logs that grow fastest (`NODE_DEBUG=module` has produced ~90 MB), so
 * every read here stops at {@link LOG_READ_BYTES}.
 *
 * Kept free of VS Code APIs so the parsing is unit-testable.
 *
 * @module server/log-read
 */

import * as fs from 'node:fs'
import { extractWebToken } from '../env.ts'

/** Read at most this much of a log for the console/token tail. */
export const LOG_READ_BYTES = 256 * 1024

/** The console keeps this many server-log lines. */
export const LOG_TAIL_LINES = 200

/**
 * The bounded tail of a text file, decoded as UTF-8; undefined when the file is
 * missing or unreadable. A cut that lands mid-line leaves a partial first line,
 * which callers tolerate (it is never a complete log entry).
 */
export function readLogTailBytes(file: string, maxBytes = LOG_READ_BYTES): string | undefined {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      const read = fs.readSync(fd, buffer, 0, buffer.length, start)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** Read the last `maxLines` non-empty lines of a file without loading a huge log. */
export function readLogTail(file: string, maxLines = LOG_TAIL_LINES): string[] {
  const text = readLogTailBytes(file)
  if (text === undefined) return []
  return text.split(/\r?\n/).filter((line) => line.length > 0).slice(-maxLines)
}

/** The newest launch token printed in a server log, if any. */
export function readTokenFromLog(file: string): string | undefined {
  const text = readLogTailBytes(file)
  if (text === undefined) return undefined
  let token: string | undefined
  // Later lines win: the newest start prints the token that is valid now.
  for (const line of text.split(/\r?\n/)) {
    token = extractWebToken(line) ?? token
  }
  return token
}
