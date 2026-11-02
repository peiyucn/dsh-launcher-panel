import type { InstanceState } from '../state.ts'
import type { InstanceLifecycle } from '../model.ts'

export interface PreparedDsh {
  mode: 'pnpm' | 'source'
  version: string
  installDir?: string
  checkout?: string
}

export interface RuntimeHost {
  prepare(exceptId: string): Promise<PreparedDsh | undefined>
  isDshMissing(): boolean
  isHomeRunning(home: string, exceptId: string): boolean
  addActivity: (line: string, isBusy?: boolean, instanceId?: string) => number
  dbg: (line: string) => void
}

export interface InstanceRuntimeStatus {
  id: string
  name: string
  lifecycle: InstanceLifecycle
  /** True when the process is owned by systemd/docker/manual tooling, not the launcher. */
  external: boolean
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
  /** A token URL is known, so the Web UI can be opened without a fresh probe. */
  uiAvailable: boolean
  /** The port listens while this runtime does not run it and cannot identify the server behind it. */
  untrackedPort: boolean
  error: string
  url: string
  logPath: string
  logPathShort: string
}
