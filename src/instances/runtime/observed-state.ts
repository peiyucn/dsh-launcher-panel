import { resolveObservedProcess, type ObservedProcessInfo } from '../observed-process.ts'

export type ObservedResolver = (port: number) => Promise<ObservedProcessInfo>

/**
 * Read-only state of a detected (externally started) dsh process: launch token plus the
 * installation/version shown in the panel. Kept out of the runtime state machine so the
 * observed branch stays one place instead of scattered fields.
 */
export class ObservedState {
  private info: ObservedProcessInfo = {}
  private readonly resolve: ObservedResolver

  constructor(resolve: ObservedResolver = resolveObservedProcess) {
    this.resolve = resolve
  }

  /** Resolve the current token for `port`; the last result also feeds the status fields. */
  async resolveToken(port: number): Promise<string | undefined> {
    this.info = await this.resolve(port)
    return this.info.token
  }

  reset(): void {
    this.info = {}
  }

  get tokenError(): string {
    return this.info.tokenError ?? ''
  }

  get packagePath(): string {
    return this.info.packagePath ?? ''
  }

  get version(): string {
    return this.info.version ?? ''
  }
}
