/**
 * The URL that serves the web UI, and the one-time token it needs.
 *
 * dsh ≥ 0.1.2-alpha.1 answers token-less requests with 401 and prints a launch
 * token on startup; older versions serve the plain URL directly. Rather than
 * branching on the version, this probes which one actually answers — so a
 * checkout mid-upgrade, or a build whose version string is wrong, still works.
 *
 * The token is per run: dsh mints a new one each start, so a cached value that
 * stops being accepted is dropped rather than retried.
 *
 * @module server/web-url
 */

import { HTTP_PROBE_TIMEOUT_MS } from '../timing.ts'
import { extractWebToken } from '../env.ts'
import { httpOk, tokenAccepted } from './probes.ts'
import { scanLogForToken } from './activity.ts'

/** The loopback host dsh binds and the launcher probes. */
export const LOOPBACK_HOST = '127.0.0.1'

/** The web access token of the current run (dsh ≥ 0.1.2-alpha.1 prints one). */
let webToken: string | undefined

/** Drop the cached token (a new run mints its own). */
export function clearWebToken(): void {
  webToken = undefined
}

/**
 * The token dsh ≥ 0.1.2-alpha.1 prints on startup (e.g.
 * `dsh web: http://127.0.0.1:3080/?token=…`): the web UI answers 401 without
 * it. Read it from the server log — the single output sink on every platform —
 * and cache it for the run.
 */
export function readServerToken(): string | undefined {
  if (webToken) return webToken
  const token = scanLogForToken(extractWebToken)
  if (token) webToken = token
  return token
}

/** The URL to open for the user, carrying the token when this run has one. */
export function uiUrl(port: number): string {
  const token = webToken ? `/?token=${webToken}` : ''
  return `http://${LOOPBACK_HOST}:${port}${token}`
}

/** The URL shown in the panel/status line — never carries the auth token. */
export function displayUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`
}

/**
 * The URL that actually serves the web UI, or undefined while it is not ready
 * yet. Version-agnostic by probing instead of assuming: older dsh versions
 * (pkg or source) serve the plain URL directly, so it is tried first; dsh ≥
 * 0.1.2-alpha.1 answers token-less requests with 401 and needs the token URL
 * it prints on startup. A cached token that no longer works is dropped, so
 * the next poll rescans the log instead of being stuck on a dead token.
 */
export async function resolveWebUrl(port: number, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<string | undefined> {
  const plain = `http://${LOOPBACK_HOST}:${port}/`
  if (await httpOk(plain, timeoutMs)) {
    // The plain URL serves: whatever token was cached belongs to another run
    // (or the version never prints one), so the browser gets the plain URL.
    webToken = undefined
    return plain
  }
  const token = readServerToken()
  if (token) {
    const tokenUrl = `http://${LOOPBACK_HOST}:${port}/?token=${token}`
    if (await tokenAccepted(tokenUrl, timeoutMs)) return tokenUrl
    // Stale or not yet accepted: drop the cache so the next poll rescans.
    webToken = undefined
  }
  return undefined
}
