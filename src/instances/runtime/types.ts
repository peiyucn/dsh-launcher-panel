import type { InstanceState } from '../state.ts'

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

  observed: boolean

  observedPackagePath: string
  observedPackagePathShort: string
  observedVersion: string
  home: string
  homeShort: string
  profile: string
  port: number
  state: InstanceState
  running: boolean
  starting: boolean
  installing: boolean
  stopping: boolean

  adopted: boolean

  uiAvailable: boolean

  untrackedPort: boolean
  error: string
  url: string
  logPath: string
  logPathShort: string
}
