/**
 * The launcher's view of the dsh server lifecycle.
 *
 * A phase machine rather than a set of booleans, because the states are
 * mutually exclusive and some transitions are meaningless (nothing goes from
 * `running` straight to `installing`). Invalid transitions are reported rather
 * than enforced — a stray assignment should be visible in the debug log, not
 * crash a teardown that is already underway.
 *
 * @module phases
 */

/**
 * The dsh server lifecycle phase (the launcher's own view of it). `installing`
 * is the first-run setup (download / clone / build) before any spawn.
 */
export type ServerPhase = 'stopped' | 'installing' | 'starting' | 'running' | 'stopping'

/** Valid direct transitions between server lifecycle phases. */
const SERVER_PHASE_TRANSITIONS: Record<ServerPhase, ServerPhase[]> = {
  stopped: ['starting'],
  installing: ['starting', 'stopping', 'stopped'],
  starting: ['installing', 'running', 'stopping', 'stopped'],
  running: ['stopping'],
  stopping: ['stopped'],
}

/** Whether a transition from → to is allowed. */
export function canTransition(from: ServerPhase, to: ServerPhase): boolean {
  return SERVER_PHASE_TRANSITIONS[from].includes(to)
}
