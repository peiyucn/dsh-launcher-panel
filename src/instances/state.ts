export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type InstanceEvent =
  | 'start'
  | 'ready'
  | 'adopt'
  | 'fail'
  | 'stop'
  | 'stop-complete'
  | 'cleanup'
  | 'exit'
  | 'lost'

type TransitionTable = {
  readonly [S in InstanceState]: { readonly [E in InstanceEvent]?: InstanceState }
}

const TRANSITIONS: TransitionTable = {
  stopped: {
    start: 'starting',
    adopt: 'running',
    stop: 'stopping',
    fail: 'error',
    cleanup: 'stopped',
  },
  starting: {
    ready: 'running',
    fail: 'error',
    stop: 'stopping',
    cleanup: 'stopped',
  },
  running: {
    adopt: 'running',
    stop: 'stopping',
    fail: 'error',
    exit: 'stopped',
    lost: 'stopped',
  },
  stopping: {
    'stop-complete': 'stopped',
    fail: 'error',
    exit: 'stopped',
  },
  error: {
    start: 'starting',
    adopt: 'running',
    stop: 'stopping',
    fail: 'error',
    cleanup: 'stopped',
  },
}

export function nextState(from: InstanceState, event: InstanceEvent): InstanceState | undefined {
  return TRANSITIONS[from][event]
}

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return Object.values(TRANSITIONS[from]).includes(to)
}

export function holdsHome(state: InstanceState, hasTrackedProcess: boolean, untrackedPort: boolean): boolean {
  if (state === 'running' || state === 'starting' || state === 'stopping') return true
  return state === 'error' && (hasTrackedProcess || untrackedPort)
}

export type StopPlan =
  | 'cleanup'
  | 'kill-tracked'
  | 'kill-identified'
  | 'unidentified'

export function stopPlan(input: {
  hasTrackedChild: boolean
  portOpen: boolean
  identified: boolean
}): StopPlan {
  if (input.hasTrackedChild) return 'kill-tracked'
  if (!input.portOpen) return 'cleanup'
  return input.identified ? 'kill-identified' : 'unidentified'
}
