/**
 * Shared session / token configuration helpers.
 *
 * Single source of truth for parsing TOKEN_REFRESH_THRESHOLD_MS and
 * SESSION_MAX_AGE environment variables, imported by:
 *
 *   - auth.ts                 — REFRESH_THRESHOLD_MS (jwt look-ahead) and maxAge
 *   - refresh-google-token.ts — MIN_EXPIRES_IN floor guard
 *   - lib/env-validation.ts   — startup validation warnings (via requireValidEnv)
 *
 * Parsing rules:
 *   - parseInt + isFinite guard (rejects NaN, Infinity, non-numeric strings)
 *   - per-variable floor / default documented on each function
 *
 * All functions read process.env on every call so they pick up runtime overrides
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
 *
 * **Upstream constraint**: `refresh-google-token.ts` converts this value to
 * seconds and uses it as `MIN_EXPIRES_IN = min(1800, max(300, threshold_s))`.
 * Values ≥ 1 800 000 ms (30 min) push MIN_EXPIRES_IN toward 1 800 s, causing
 * every standard Google `expires_in: 3600` response to barely pass.  The
 * startup warning in `lib/env-validation.ts` flags values ≥ 1 800 000 ms and
 * recommends ≤ 1 500 000 ms for a healthy margin.
 */
export function getRefreshThresholdMs(): number {
  const raw = process.env.TOKEN_REFRESH_THRESHOLD_MS
  if (raw === undefined || raw === '') return DEFAULT_THRESHOLD_MS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < FLOOR_MS) return DEFAULT_THRESHOLD_MS

  return parsed
}

/**
 * Maximum number of entries in the in-process polling session cache
 * (`PollingSessionCache`) and the concurrent-refresh deduplication map
 * (`activeRefreshes` in `refresh-google-token.ts`).
 *
 * Both maps share this ceiling so the two magic `500`s can't drift apart
 * independently.  500 entries covers ~500 concurrent active-polling users per
 * Cloud Run instance; at maxEntries the cache evicts oldest-first (FIFO) and
 * the dedup map bypasses dedup rather than evicting in-flight Promises.
 */
export const POLLING_CACHE_MAX_ENTRIES = 500

/** Default session lifetime: 24 hours in seconds. */
const DEFAULT_SESSION_MAX_AGE_S = 24 * 60 * 60

/**
 * Returns the configured JWT session lifetime in **seconds**.
 *
 * Reads `SESSION_MAX_AGE` from the environment and applies:
 *   1. `parseInt` + `isFinite` — rejects NaN / Infinity / non-numeric strings
 *   2. Positive-integer check — zero or negative values are rejected
 *   3. Falls back to 86 400 s (24 h) when the value is absent or rejected
 *
 * @returns Effective session max age in seconds (always > 0).
 */
export function getSessionMaxAgeSecs(): number {
  const raw = process.env.SESSION_MAX_AGE
  if (raw === undefined || raw === '') return DEFAULT_SESSION_MAX_AGE_S

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_MAX_AGE_S

  return parsed
}
