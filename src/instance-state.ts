export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

// Events are named after the cause, so a caller cannot ask for an arbitrary jump.
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

// `starting` has no exit/lost edge: a failed start must go through `fail` so the panel reports
// a reason instead of looking idle. `cleanup` only serves a Stop requested before any process exists.
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

// A `stopping` runtime still owns its child, and an `error` runtime can still hold a live child
// (failed Stop) or a listening port (failed start/stop), so both keep blocking the same home.
export function holdsHome(state: InstanceState, hasTrackedProcess: boolean, untrackedPort: boolean): boolean {
  if (state === 'running' || state === 'starting' || state === 'stopping') return true
  return state === 'error' && (hasTrackedProcess || untrackedPort)
}

type StopDecision =
  | 'cleanup'
  | 'ask'
  | 'kill'

// A tracked child is ours to kill; an untracked port owner may be anyone, so it needs consent.
export function stopDecision(input: {
  hasTrackedChild: boolean
  portOpen: boolean
  killUntracked: boolean
}): StopDecision {
  if (input.hasTrackedChild) return 'kill'
  if (!input.portOpen) return 'cleanup'
  return input.killUntracked ? 'kill' : 'ask'
}
