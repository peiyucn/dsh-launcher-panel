/**
 * Every timeout and size bound the launcher applies, in one place.
 *
 * These are grouped by *what they bound*, because that is what the numbers
 * mean: a probe of this machine, a round trip to a registry, or a transfer
 * whose size the launcher cannot predict. Mixing the three is what produced a
 * false "timed out" on a slow day (see {@link GIT_REMOTE_TIMEOUT_MS}).
 *
 * @module timing
 */

// --- Local probes (loopback sockets, local processes) ---

export const PORT_PROBE_TIMEOUT_MS = 500
export const PORT_POLL_INTERVAL_MS = 500
export const STOP_POLL_INTERVAL_MS = 200
export const STOP_POLL_ATTEMPTS = 10
export const STOP_POLL_PROBE_MS = 300
export const HTTP_PROBE_TIMEOUT_MS = 2_000
export const NODE_PROBE_TIMEOUT_MS = 8_000
export const PNPM_PROBE_TIMEOUT_MS = 8_000
export const TASKKILL_TIMEOUT_MS = 5_000

/** How long a detected environment fact is reused before it is probed again. */
export const DETECTION_CACHE_TTL_MS = 8_000

/** How often the panel refreshes its status (drives the webview timer). */
export const STATUS_REFRESH_INTERVAL_MS = 4_000

// --- Network, small answer (the round trip is the cost, not the payload) ---

/** A registry lookup (`pnpm view`). Same reasoning as {@link GIT_REMOTE_TIMEOUT_MS}. */
export const PNPM_VIEW_TIMEOUT_MS = 60_000

/**
 * A git query that reaches the origin but transfers no history (`ls-remote`).
 *
 * This used to share {@link GIT_OP_TIMEOUT_MS} on the reasoning that a small
 * *payload* means a fast call. Payload is not latency: the round trip still pays
 * DNS, TCP, TLS, the proxy hop, and GitHub's own slowness. Measured against
 * GitHub through a working proxy, the same `ls-remote` returned in ~1.05 s six
 * times in a row and took 16.2 s once — a spread that straddles any short bound,
 * so a 10 s limit turns one slow moment into a false "timed out" on a check that
 * would have succeeded. A bounded-but-generous limit keeps the refresh honest
 * without letting a dead connection spin forever.
 */
export const GIT_REMOTE_TIMEOUT_MS = 60_000

// --- Network, history transfer (the payload is the cost) ---

/**
 * A git operation that transfers history (`fetch`). The payload scales with the
 * gap between the checkout and the target tag — 0.1.5-rc.2 → 0.1.7-alpha.1 is
 * ~186 MB / ~95k objects — and the launcher cannot know how far behind a user
 * is, so this must not track {@link GIT_OP_TIMEOUT_MS}.
 */
export const GIT_FETCH_TIMEOUT_MS = 15 * 60_000

// --- Local git only ---

/**
 * Purely local git queries (`describe`, `rev-parse`, `merge-base`, `config`):
 * they read this machine's object store and config, so a short bound is right —
 * but a bound is still needed, because a wedged git process would otherwise hang
 * the refresh forever.
 *
 * Network operations must not use this: see {@link GIT_REMOTE_TIMEOUT_MS}.
 */
export const GIT_OP_TIMEOUT_MS = 10_000

// --- Bounded accumulation ---

/** Activity feed lines kept for the panel console. */
export const ACTIVITY_MAX_LINES = 200
/** Server log lines re-read after a reload marker. */
export const LOG_RELOAD_LINES = 50
/** Progress print every N module loads when `dsh.sourceDebug` is on. */
export const MODULE_PROGRESS_EVERY = 500
/** How often the server log tail is appended to the console. */
export const LOG_TAIL_POLL_MS = 500
