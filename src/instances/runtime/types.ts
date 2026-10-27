import type { InstanceState } from '../state.ts'

export interface PreparedDsh {
  mode: 'pnpm' | 'source'
  version: string
  /** pnpm may be a `.cmd` shim; resolve it before spawning. */
  pnpmCmd?: string
  installDir?: string
  checkout?: string
}

export interface RuntimeHost {
  prepare(): Promise<PreparedDsh | undefined>
  isDshMissing(): boolean
  isHomeRunning(home: string, exceptId: string): boolean
  addActivity: (line: string, isBusy?: boolean, instanceId?: string) => number
  dbg: (line: string) => void
}

export interface InstanceRuntimeStatus {
  id: string
  name: string
  home: string
  homeShort: string
  profile: string
  port: number
  state: InstanceState
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean
  /** A server answers on the port but this window does not track its process. */
  adopted: boolean
  /** The port listens while this runtime does not run it: Stop needs consent. */
  untrackedPort: boolean
  error: string
  url: string
  logPath: string
  logPathShort: string
}
