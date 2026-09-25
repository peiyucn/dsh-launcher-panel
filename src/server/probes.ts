/**
 * Liveness probes: is something listening, and is it answering?
 *
 * These are the launcher's only way to tell "the server is up" from "the
 * process is alive but not serving yet". They are deliberately
 * version-agnostic — they probe rather than assume, because dsh's readiness
 * contract changed at 0.1.2-alpha.1 (older versions serve the plain URL, newer
 * ones answer token-less requests with 401).
 *
 * Every function here resolves instead of throwing: a probe that fails is a
 * negative answer, never an exception the caller has to guard.
 *
 * @module server/probes
 */

import * as net from 'node:net'
import { HTTP_PROBE_TIMEOUT_MS, PORT_PROBE_TIMEOUT_MS } from '../timing.ts'

/** Non-destructive port probe; resolves without throwing. */
export function isPortOpen(host: string, port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: net.Socket
    try {
      socket = new net.Socket()
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // already closed
      }
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

/** Whether a GET against `url` answers 2xx (resolves without throwing). */
export async function httpOk(url: string, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a token URL proves the server is up. dsh ≥ 0.1.2-alpha.1 answers a
 * valid launch token with a 303 cookie-minting redirect; following it without
 * a cookie jar lands back on a 401 (undici's fetch keeps no cookies), so the
 * probe stops at the redirect — the browser performs the cookie dance itself
 * when the tab opens the token URL.
 */
export async function tokenAccepted(url: string, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    return res.status === 303 || res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
