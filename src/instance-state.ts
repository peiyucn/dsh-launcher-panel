/**
 * The per-instance lifecycle state machine, as a pure transition table.
 *
 * Keeping the legal edges here does two things: it makes them testable without
 * VS Code (spec §14 asks for exactly this), and it stops failure paths from
 * jumping straight back to `stopped` — a start that failed while `starting` has
 * to be reported as `error`, not look like it never ran.
 *
 * @module instance-state
 */

/** Coarse lifecycle state; `installing` is a transient flag on top of `starting`. */
export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * One thing that happens to a runtime. Events are named after the cause, not
 * the target state, so a caller cannot ask for an arbitrary jump.
 */
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

/**
 * Legal lifecycle edges.
 *
 * - `starting` has no `exit`/`lost`/`stop-complete` edge: a start that failed
 *   must go through `fail` (→ `error`) so the panel reports a reason instead of
 *   silently looking idle. The explicit `cleanup` edge only serves a Stop
 *   requested before any process exists.
 * - `running --exit--> stopped` is the unexpected-exit path (the reason and the
 *   log path are recorded by the caller); `lost` is the same outcome when a
 *   status refresh finds the port closed.
 * - `cleanup` clears an `error` state once nothing is tracked and no port is
 *   listening (a manual Stop on a failed instance).
 */
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
    // A Stop before the spawn (install/detection/profile init still running)
    // has no process to clean up; stopping it must still leave `starting`.
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

/** The state `event` leads to from `from`; undefined when that edge is illegal. */
export function nextState(from: InstanceState, event: InstanceEvent): InstanceState | undefined {
  return TRANSITIONS[from][event]
}

/** Whether any event leads from `from` to `to`. */
export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return Object.values(TRANSITIONS[from]).includes(to)
}

/**
 * Whether this runtime still reserves its DSH home.
 *
 * Spec §10 allows only one server per normalized home. A runtime in `stopping`
 * still owns its child/home, and an `error` runtime can still hold a live child
 * (failed Stop) or a listening port (failed start/stop) — those must keep
 * blocking another instance with the same home.
 */
export function holdsHome(state: InstanceState, hasTrackedProcess: boolean, untrackedPort: boolean): boolean {
  if (state === 'running' || state === 'starting' || state === 'stopping') return true
  if (state === 'error') return hasTrackedProcess || untrackedPort
  return false
}

/** What a Stop request has to do before any process is touched. */
export type StopDecision =
  /** Nothing is tracked and nothing listens: only clear the lifecycle state. */
  | 'cleanup'
  /** Nothing is tracked but the port is held by a process we did not start. */
  | 'ask'
  /** A tracked child is ours to kill (plus the port owner when consented). */
  | 'kill'

/**
 * The ownership rule behind Stop (spec §8/§12).
 *
 * A tracked child always belongs to this runtime and may be killed. Without one,
 * a listening port may be anything — the user's own server, another launcher, a
 * stale dsh — so it is only killed after explicit consent (`killUntracked`).
 * Callers must show a confirmation when this returns `ask`.
 */
export function stopDecision(input: {
  hasTrackedChild: boolean
  portOpen: boolean
  killUntracked: boolean
}): StopDecision {
  if (input.hasTrackedChild) return 'kill'
  if (!input.portOpen) return 'cleanup'
  return input.killUntracked ? 'kill' : 'ask'
}
