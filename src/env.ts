/**
 * Small pure helpers that do not belong to a subsystem: config values, log
 * parsing, and platform-independent text shaping.
 *
 * The test in `test/common.test.ts` treats these as the launcher's string
 * boundary — anything here must stay free of Node and VS Code APIs.
 *
 * @module env
 */

import { DSH_CLI_ENTRY_GUARD_MIN_VERSION, dshVersionAtLeast } from './versions.ts'

/** The port the web UI listens on when `dsh.port` is unset (mirrors package.json). */
export const DEFAULT_PORT = 3080

/** Default browser mode; normalizeBrowser collapses any other value onto it. */
export const DEFAULT_BROWSER = 'built-in'

/** Highest valid TCP port; `dsh.port` values above this are clamped back to the default. */
export const MAX_PORT = 65535

/** CSP nonce length in characters (random, not crypto-critical, but unpredictable). */
export const NONCE_LENGTH = 32

/** Normalize an arbitrary `dsh.browser` config value to a known choice. */
export function normalizeBrowser(value: unknown): 'built-in' | 'external' {
  return value === 'external' ? 'external' : DEFAULT_BROWSER
}

/** The npm dist-tag channel the launcher installs and updates from. */
export type NpmChannel = 'latest' | 'next' | 'alpha'

/** 归一化 npm 通道配置（settings 值可能是任意字符串）。 */
export function parseNpmChannel(value: string | undefined): NpmChannel {
  return value === 'next' || value === 'alpha' ? value : 'latest'
}

/** npm 通道 → 解析规格（latest 是默认 dist-tag 不带后缀；next/alpha 显式指定）。 */
export function npmSpecForChannel(channel: NpmChannel): string {
  return channel === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${channel}`
}

/**
 * Whether a start action should open the browser. An explicit re-open (the
 * Start button when the server is already running) always opens; the
 * automatic open after a fresh start honours dsh.autoOpenBrowser (default on).
 */
export function shouldOpenBrowser(autoOpenBrowser: boolean | undefined, alreadyRunning: boolean): boolean {
  if (alreadyRunning) return true
  return autoOpenBrowser !== false
}

/** Strip non-ASCII characters and trailing parentheticals to yield an English name. */
export function toEnglish(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The one-time web access token dsh ≥ 0.1.2-alpha.1 prints in its startup URL. */
const WEB_TOKEN_RE = /[?&]token=([A-Za-z0-9_-]{8,})/

/** Extract the web access token from a server output line (undefined when absent). */
export function extractWebToken(line: string): string | undefined {
  return WEB_TOKEN_RE.exec(line)?.[1]
}

/** Whether the Node capability probe reported `import.meta.main` as present. */
export function parseImportMetaMainProbe(stdout: string): boolean {
  return stdout.trim() === 'true'
}

/**
 * Explanation for a server that exited before opening its port without
 * printing anything, when the configured Node cannot run dsh's guarded CLI
 * entry. Returns undefined when there is nothing to explain, so an ordinary
 * failure keeps its own (already reported) cause.
 */
export function silentExitHint(input: {
  /** The dsh version about to run ('' when unknown). */
  dshVersion: string
  /** The configured Node version without the leading `v` ('' when unknown). */
  nodeVersion: string
  /** Whether the Node capability probe found `import.meta.main`. */
  supportsImportMetaMain: boolean
  /** Server output lines captured for the run that just exited. */
  outputLines: number
}): string | undefined {
  if (input.outputLines > 0 || input.supportsImportMetaMain) return undefined
  return guardHint(input.dshVersion, input.nodeVersion)
}

/** The Node-capability sentence, split out so the guard rule stays readable. */
function guardHint(dshVersion: string, nodeVersion: string): string | undefined {
  // An unknown or older dsh does not use the guard, so stay out of the way.
  if (!dshVersionAtLeast(dshVersion, DSH_CLI_ENTRY_GUARD_MIN_VERSION)) return undefined
  const node = nodeVersion ? `Node v${nodeVersion}` : 'The configured Node'
  return `${node} lacks import.meta.main — dsh ≥ ${DSH_CLI_ENTRY_GUARD_MIN_VERSION} starts its CLI through it (needs Node 22.18+ or 24.2+), so the server exits silently. Upgrade Node, then start again`
}
