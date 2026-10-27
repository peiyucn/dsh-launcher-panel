// Keep in sync with the dsh.port default in package.json.
export const DEFAULT_PORT = 3080

export const DEFAULT_INSTANCE_PORT_BASE = 31000
export const MIN_INSTANCE_PORT_BASE = 10000
export const DEFAULT_BROWSER = 'built-in'
export const MAX_PORT = 65535
export const NONCE_LENGTH = 32

export function normalizeBrowser(value: unknown): 'built-in' | 'external' {
  return value === 'external' ? 'external' : DEFAULT_BROWSER
}

export type NpmChannel = 'latest' | 'next' | 'alpha'

export function parseNpmChannel(value: string | undefined): NpmChannel {
  return value === 'next' || value === 'alpha' ? value : 'latest'
}

export function npmSpecForChannel(channel: NpmChannel): string {
  return channel === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${channel}`
}

export function shouldOpenBrowser(autoOpenBrowser: boolean | undefined, alreadyRunning: boolean): boolean {
  return alreadyRunning || autoOpenBrowser !== false
}

export function toEnglish(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, ' ').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function extractWebToken(line: string): string | undefined {
  return /[?&]token=([A-Za-z0-9_-]{8,})/.exec(line)?.[1]
}
