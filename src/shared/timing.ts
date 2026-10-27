export const PORT_PROBE_TIMEOUT_MS = 500
export const PORT_POLL_INTERVAL_MS = 500
export const STOP_POLL_INTERVAL_MS = 200
export const STOP_POLL_ATTEMPTS = 10
export const STOP_POLL_PROBE_MS = 300
export const HTTP_PROBE_TIMEOUT_MS = 2_000
export const NODE_PROBE_TIMEOUT_MS = 8_000
export const PNPM_PROBE_TIMEOUT_MS = 8_000
export const TASKKILL_TIMEOUT_MS = 5_000
export const DETECTION_CACHE_TTL_MS = 8_000
export const PANEL_REFRESH_INTERVAL_MS = 4_000
export const STATUS_BAR_REFRESH_INTERVAL_MS = 15_000
export const UPDATE_CHECK_TTL_MS = 5 * 60_000

// Remote round trips and history transfers are latency/payload bound, so the git bounds stay generous.
export const GIT_REMOTE_TIMEOUT_MS = 60_000
export const PNPM_VIEW_TIMEOUT_MS = 60_000
export const GIT_FETCH_TIMEOUT_MS = 15 * 60_000

export const GIT_OP_TIMEOUT_MS = 10_000

export const ACTIVITY_MAX_LINES = 200
export const LOG_RELOAD_LINES = 50
// One activity line can be an entire tool output, so cap characters too or it bypasses the line cap.
export const ACTIVITY_LINE_MAX_CHARS = 8 * 1024
export const ACTIVITY_LOG_MAX_BYTES = 5 * 1024 * 1024
export const ACTIVITY_LOG_KEEP_BYTES = 256 * 1024
export const LOG_TAIL_POLL_MS = 500
