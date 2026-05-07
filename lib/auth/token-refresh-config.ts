/**
 * Shared TOKEN_REFRESH_THRESHOLD_MS parsing helper.
 *
 * This module is the single source of truth for reading and validating the
 * TOKEN_REFRESH_THRESHOLD_MS environment variable.  It is imported by:
 *
 *   - auth.ts              — REFRESH_THRESHOLD_MS for the proactive jwt() look-ahead
 *   - refresh-google-token.ts — MIN_EXPIRES_IN floor guard
 *   - lib/env-validation.ts   — startup validation warning
 *
 * Parsing rules:
 *   - parseInt + isFinite guard (rejects NaN, Infinity, non-numeric strings)
 *   - 60 000 ms floor (prevents accidentally disabling proactive refresh)
 *   - Default: 300 000 ms (5 minutes) when absent, malformed, or below floor
 *
 * The function reads process.env on every call so it picks up runtime overrides
 * in tests (jest.resetModules / process.env mutation between test cases).
 */

/** Default refresh threshold: 5 minutes in milliseconds. */
const DEFAULT_THRESHOLD_MS = 5 * 60 * 1000

/** Absolute minimum threshold: 60 seconds in milliseconds. */
const FLOOR_MS = 60_000

/**
 * Returns the configured access-token refresh look-ahead in **milliseconds**.
 *
 * Reads `TOKEN_REFRESH_THRESHOLD_MS` from the environment and applies:
 *   1. `parseInt` + `isFinite` — rejects NaN / Infinity / non-numeric strings
 *   2. 60 000 ms floor — prevents sub-minute thresholds that would cause a
 *      hot-refresh loop against Google's token endpoint
 *   3. Falls back to 300 000 ms (5 min) when the value is absent or rejected
 *
 * @returns Effective threshold in milliseconds (always ≥ 60 000).
 */
export function getRefreshThresholdMs(): number {
  const raw = process.env.TOKEN_REFRESH_THRESHOLD_MS
  if (raw === undefined || raw === '') return DEFAULT_THRESHOLD_MS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < FLOOR_MS) return DEFAULT_THRESHOLD_MS

  return parsed
}
