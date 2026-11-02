import { activityLogFile, fileSizeSafe, instanceActivityLogFile } from '../shared/activity.ts'
import { readConfig } from '../dsh/config.ts'
import { maskPath } from '../dsh/paths.ts'
import { isUpdating, type DshUpdate } from '../dsh/update.ts'
import type { InstanceIssue } from './model.ts'
import type { InstanceRuntimeStatus } from './runtime/types.ts'

export interface InstanceDashboard {
  status: {
    running: boolean
    starting: boolean
    installing: boolean
    stopping: boolean
    checking: boolean
    updating: boolean
    url: string
    dsh: 'unknown' | 'ok' | 'missing'
    dshVersion: string
    dshPath: string
    dshHome: string
    dshPathShort: string
    dshHomeShort: string
    nodeVersion: string
    mode: 'pnpm' | 'source'
    update: DshUpdate | undefined
    consoleLogPath: string
    consoleLogPathShort: string
    serverLogPath: string
    serverLogPathShort: string
    consoleLogSize: number
    serverLogSize: number
    sourceDebug: boolean
  }
  instances: InstanceRuntimeStatus[]
  active: InstanceRuntimeStatus | undefined
  activeId: string
  issues: InstanceIssue[]
}

export interface DashboardFacts {
  instances: InstanceRuntimeStatus[]
  activeId: string
  issues: InstanceIssue[]
  checking: boolean
  update: DshUpdate | undefined
  dsh: 'unknown' | 'ok' | 'missing'
  dshVersion: string
  dshPath: string
  nodeVersion: string
}

export interface DashboardSource {
  ready(): Promise<void>
  refresh(): Promise<void>
  facts(): DashboardFacts
}

export async function buildDashboard(source: DashboardSource): Promise<InstanceDashboard> {
  try {
    await source.ready()
  } catch {
    // The failure is surfaced through issues().
  }
  await source.refresh()
  const facts = source.facts()
  const cfg = readConfig()
  const active = facts.instances.find((instance) => instance.id === facts.activeId)
  const consoleLogPath = active ? instanceActivityLogFile(active.id) : activityLogFile()
  return {
    status: {
      running: active?.running ?? false,
      starting: active?.starting ?? false,
      installing: active?.installing ?? false,
      stopping: active?.stopping ?? false,
      checking: facts.checking,
      updating: isUpdating(),
      url: active?.url ?? '',
      dsh: facts.dsh,
      dshVersion: facts.dshVersion,
      dshPath: facts.dshPath,
      dshHome: active?.home ?? '',
      dshPathShort: maskPath(facts.dshPath),
      dshHomeShort: maskPath(active?.home ?? ''),
      nodeVersion: facts.nodeVersion,
      mode: cfg.runMode,
      update: facts.update,
      consoleLogPath,
      consoleLogPathShort: maskPath(consoleLogPath),
      serverLogPath: active?.logPath ?? '',
      serverLogPathShort: active?.logPathShort ?? '',
      consoleLogSize: fileSizeSafe(consoleLogPath),
      serverLogSize: active ? fileSizeSafe(active.logPath) : 0,
      sourceDebug: cfg.sourceDebug,
    },
    instances: facts.instances,
    active,
    activeId: facts.activeId,
    issues: facts.issues,
  }
}
