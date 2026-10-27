import * as net from 'node:net'
import { HTTP_PROBE_TIMEOUT_MS, PORT_PROBE_TIMEOUT_MS } from '../timing.ts'

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
        // Already closed.
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

async function request(url: string, timeoutMs: number, redirect?: 'manual'): Promise<Response | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, redirect ? { signal: controller.signal, redirect } : { signal: controller.signal })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export async function httpOk(url: string, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<boolean> {
  const res = await request(url, timeoutMs)
  if (res === undefined) return false
  try {
    return res.ok
  } finally {
    // Undici keeps a connection pooled until the body is consumed or cancelled.
    await res.body?.cancel().catch(() => {})
  }
}

export async function tokenAccepted(url: string, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<boolean> {
  // dsh >= 0.1.2-alpha.1 answers a valid token with a 303 cookie-minting redirect.
  // fetch has no cookie jar, so stop at the redirect instead of landing on a 401.
  const res = await request(url, timeoutMs, 'manual')
  if (res === undefined) return false
  try {
    return res.status === 303 || res.ok
  } finally {
    await res.body?.cancel().catch(() => {})
  }
}
