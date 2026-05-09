/**
 * Google OAuth2 access-token refresh
 *
 * Extracted from auth.ts so it can be imported and tested directly without
 * loading the full NextAuth config (which has side-effects and requires all
 * provider env vars to be set).
 *
 * Behaviour:
 * - Returns `null` immediately if no refresh token or secret is present —
 *   callers treat null as "force re-authentication".
 * - Preserves a rotated refresh_token when Google returns one (rotation is
 *   triggered on security events or when rotation is explicitly configured).
 * - Floors `expires_in` at 60 s so a zero/missing value from Google during
 *   clock-skew incidents never produces an already-expired timestamp that
 *   would cause an immediate re-refresh loop.
 */

import type { JWT } from "next-auth/jwt"
import { createLogger } from "@/lib/auth/edge-logger"
import { getRefreshThresholdMs, POLLING_CACHE_MAX_ENTRIES } from "@/lib/auth/token-refresh-config"

/**
 * In-process deduplication map: sub → in-flight refresh Promise.
 *
 * When multiple JWT callbacks fire concurrently for the same user (e.g. a
 * page that renders several RSCs each triggering `auth()`), only the first
 * one POSTs to Google's token endpoint.  All others await the same Promise,
 * so they share the single refreshed token and never send a duplicate request
 * that could race against Google's optional refresh-token rotation.
 *
 * The map entry is deleted as soon as the Promise settles (success or error),
 * so the next expiry window starts a fresh request.
 *
 * Note: dedup is per-process. On multi-instance deployments (e.g. Cloud Run
 * with several pods) each instance independently refreshes — token endpoints
 * are designed for this traffic level, so the cross-instance duplication is
 * acceptable in practice.
 *
 * Bound analysis: entries are deleted in `.finally()` when the Promise settles.
 * `fetch` always eventually settles (Node's HTTP agent enforces socket timeouts),
 * so the map is effectively bounded by concurrent users whose tokens expire at
 * the same instant — negligible in practice.
 *
 * Key: `sub:loginIat` (or just `sub` for legacy JWTs without loginIat).  Keying
 * on loginIat prevents cross-device clobber: two browsers signed into the same
 * Google account with distinct JWTs share the same `sub` but have different
 * `loginIat` values; without loginIat in the key, the second browser would join
 * the first's Promise and receive a JWT spread from the wrong token, silently
 * overwriting its loginIat — breaking the polling-session-cache key on every
 * subsequent request for that session.
 *
 * Soft cap: when the map reaches POLLING_CACHE_MAX_ENTRIES (500), a throttled
 * warn is emitted and the caller still falls through to the normal dedup path —
 * the new session's Promise is inserted and cleaned up in `.finally()` exactly
 * like any other entry.  Per-session deduplication is **always active**, even at
 * capacity.  The map can temporarily exceed 500 by one entry per distinct session
 * that enters the cap branch concurrently; `.finally()` shrinks it back as
 * Promises settle.  The cap is a circuit-breaker signal (500 distinct sessions
 * refreshing simultaneously is anomalous), not a hard bound on map size.
 */
const activeRefreshes = new Map<string, Promise<JWT | null>>()

// Throttle the at-capacity warn to at most once per minute so a sustained burst
// (500+ concurrent distinct sessions) doesn't flood telemetry with redundant lines.
// omittedCapWarns counts how many cap-hit events were suppressed since the last
// emitted warn — included in the next warn so operators can distinguish a
// momentary spike (omittedCapWarns: 0) from a sustained anomaly (omittedCapWarns: N).
let lastCapWarnAt = 0
let omittedCapWarns = 0
const CAP_WARN_THROTTLE_MS = 60_000

/**
 * Returns the number of in-flight refresh Promises currently tracked by the
 * dedup map.  Exported exclusively for unit-test assertions — call sites in
 * production code should use refreshGoogleToken() directly.
 *
 * @internal
 */
export function getActiveRefreshCount(): number {
  return activeRefreshes.size
}

export async function refreshGoogleToken(token: JWT): Promise<JWT | null> {
  const log = createLogger({ context: "google-token-refresh" })

  // JWT['sub'] is already string | undefined — no cast needed.
  const sub = token.sub

  // Fail-closed when sub is absent: return null immediately to force re-auth
  // rather than routing through doRefresh.  A sub-less JWT is structurally
  // malformed — sub is required by the OIDC spec — so the safest response is
  // to treat it like a refresh failure and let the caller trigger a new sign-in.
  // Keying the dedup map on a synthetic value (e.g. "anonymous") would be
  // unsafe: two concurrent sub-less callers could share a refresh Promise and
  // silently clobber each other's rotated refresh_token.
  if (!sub) {
    log.warn("refreshGoogleToken called with no sub — returning null (fail-closed)")
    return null
  }

  // Dedup key: `sub:loginIat` rather than `sub` alone.
  //
  // Within a single browser session, all concurrent callers share the same JWT
  // cookie (same sub + same loginIat), so they correctly share one Promise.
  //
  // Cross-device concurrency (same Google account signed into two browsers, or
  // two tabs from different sign-in flows with distinct cookies) produces JWTs
  // with the same `sub` but different `loginIat` values.  Keying on `sub` alone
  // caused the second caller to join the first's Promise, and the resulting JWT
  // was spread from the first caller's token — silently overwriting the second
  // caller's `loginIat` (and any future per-session claims) with the first's.
  // That loginIat jitter was harmless for security (both callers are the same
  // Google identity) but correctness-breaking for the polling-session cache, which
  // uses `sub:loginIat` as its cache key — a refreshed JWT with the wrong loginIat
  // would miss the cache on every subsequent request for that session.
  //
  // Keying on `sub:loginIat` gives each independent browser session its own
  // in-flight slot, eliminating the cross-session clobber.
  //
  // Fallback for JWTs without loginIat (e.g. old cookies during a rolling deploy):
  // use `sub` alone — same behaviour as before, which is correct for those tokens
  // because they all have no loginIat and would produce the same polling-cache miss
  // regardless.
  const loginIat = token.loginIat
  const dedupKey = loginIat ? `${sub}:${loginIat}` : sub

  // Deduplicate concurrent refresh calls for the same user+session.
  const existing = activeRefreshes.get(dedupKey)
  if (existing) {
    log.debug("Joining existing in-flight token refresh", { sub, loginIat })
    return existing
  }

  // Safety cap: if the map grows unexpectedly large (500+ distinct sessions all
  // refreshing simultaneously), emit a throttled warn.  We still fall through
  // to the normal dedup path below rather than bypassing it, so concurrent
  // callers for the SAME new session (same dedupKey) still share one Promise.
  //
  // Prior design bypassed dedup entirely at capacity (returning doRefresh()
  // without inserting into the map).  That caused N independent fetches for
  // the same session if N callers raced after the map hit 500, each able to race
  // the prior call's refresh_token rotation.  The fix: let the map grow
  // briefly past 500 (one entry per new session — the `.finally()` cleanup shrinks
  // it back as Promises settle).  The 500-entry circuit breaker is about
  // distinct-session growth, not per-session deduplication.
  if (activeRefreshes.size >= POLLING_CACHE_MAX_ENTRIES) {
    // Throttle to ≤1 warn/minute: sustained capacity under load should produce
    // one signal line per minute, not one per request.
    const now = Date.now()
    if (now - lastCapWarnAt >= CAP_WARN_THROTTLE_MS) {
      const omitted = omittedCapWarns
      lastCapWarnAt = now
      omittedCapWarns = 0
      log.warn("activeRefreshes map at capacity (≥500 entries) — investigate if persistent; per-session dedup still active", {
        size: activeRefreshes.size,
        sub,
        loginIat,
        // omittedSinceLastWarn: 0 = momentary spike; >0 = sustained anomaly.
        // Filter on this field in Cloud Logging to distinguish burst from sustained overload.
        omittedSinceLastWarn: omitted,
      })
    } else {
      omittedCapWarns++
    }
    // Fall through — don't return early.
  }

  // Use an identity check rather than a plain delete so that a concurrent
  // insertion for the same session between the .finally() binding and when it
  // fires cannot accidentally remove the new promise.
  //
  // doRefresh() is fully `async`, so it always returns a Promise (resolving or
  // rejecting) and can never throw synchronously.  The .finally() therefore runs
  // unconditionally on both success and rejection — no outer try/catch needed
  // for cleanup.  `const` is safe here: the .finally() callback only executes
  // after the promise settles, which is after the right-hand side of the `const`
  // assignment has completed and `promise` is fully initialized.  The closure
  // captures the binding (not the value at bind-time), so by the time it runs,
  // `promise` is always defined.
  const promise = doRefresh(token, log).finally(() => {
    if (activeRefreshes.get(dedupKey) === promise) {
      activeRefreshes.delete(dedupKey)
    }
  })
  activeRefreshes.set(dedupKey, promise)
  return promise
}

async function doRefresh(token: JWT, log: ReturnType<typeof createLogger>): Promise<JWT | null> {

  if (!token.refreshToken) {
    log.warn("No refresh token available for Google token", { sub: token.sub })
    return null
  }
  // Extract to a const so TypeScript narrows the type to `string` for all
  // downstream uses — avoids the non-null assertion (`!`) at the call site
  // and makes the null-guard above clearly sufficient.
  const refreshToken = token.refreshToken

  // Return null (not throw) when credentials are absent — the misconfiguration
  // is already surfaced by validateEnv() at startup and flagged in auth.ts at
  // initial sign-in time (no Google provider is registered without both vars).
  // Sending an empty string to Google would produce a misleading "invalid_client"
  // error; early-returning null lets auth.ts handle the failure path cleanly.
  const clientId = process.env.AUTH_GOOGLE_ID
  if (!clientId) {
    log.error("AUTH_GOOGLE_ID is not set — cannot refresh Google token")
    return null
  }

  const secret = process.env.AUTH_GOOGLE_SECRET
  if (!secret) {
    log.error("AUTH_GOOGLE_SECRET is not set — cannot refresh Google token")
    return null
  }

  // 10 s abort timeout on the Google token endpoint.
  // Without this, a hung upstream would hold the Promise in the dedup map
  // indefinitely — every subsequent request for the same sub joins the hung
  // Promise and waits until Node's default socket timeout (minutes), silently
  // blocking all of that user's auth checks.  Failing fast with null lets the
  // caller force re-auth immediately instead.
  const controller = new AbortController()
  const fetchTimeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: secret,
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    })

    const tokens = (await response.json()) as {
      access_token?: string
      id_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
    }

    if (!response.ok || tokens.error) {
      log.warn("Google token refresh failed", { error: tokens.error })
      return null
    }

    // Fail-closed: Google returning 200 with a missing access_token or id_token
    // is structurally malformed — treat it like a failure rather than silently
    // storing `undefined` in the JWT, which would break downstream auth checks.
    if (!tokens.access_token || !tokens.id_token) {
      log.warn("Google token refresh returned 200 but access_token or id_token is absent — treating as failure", {
        hasAccessToken: !!tokens.access_token,
        hasIdToken: !!tokens.id_token,
      })
      return null
    }

    // Fail-closed on a pathologically small expires_in.
    //
    // Any token whose expires_in ≤ the proactive-refresh threshold would trigger
    // another refresh on the very next jwt() callback — a misbehaving upstream
    // returning a tiny expires_in causes a hot-loop against Google's token endpoint.
    //
    // Read getRefreshThresholdMs() on every call (not cached at module load) so
    // tests that mutate TOKEN_REFRESH_THRESHOLD_MS between cases see the updated
    // value — consistent with the documented contract in token-refresh-config.ts.
    // The Math.max + parseInt cost is negligible relative to an HTTP round-trip.
    //
    // MIN_EXPIRES_IN floor: Math.max(300, threshold_s) — prevents a hot-loop
    // against Google's token endpoint when expires_in is at or below the proactive-
    // refresh threshold (the next jwt() callback would immediately trigger another
    // refresh).  300 s is an absolute lower bound; an operator who raises the
    // threshold above 300 s gets the higher value enforced.
    //
    // MIN_EXPIRES_IN ceiling: capped at 1800 s (half of Google's standard 3600 s
    // lifetime).  Without a ceiling, an operator who sets TOKEN_REFRESH_THRESHOLD_MS
    // >= 3600 000 ms would make MIN_EXPIRES_IN >= 3600 s, causing every Google
    // response (expires_in: 3600) to be rejected as "too short" — the user would
    // re-auth on every refresh cycle with no indication of why.  env-validation
    // emits a warning for thresholds >= 1 800 000 ms; the cap here is the runtime
    // safety net in case the warning is missed or the validator is bypassed.
    const MIN_EXPIRES_IN = Math.min(
      1800, // ceiling: never reject Google's standard 3600 s token lifetime
      Math.max(300, Math.round(getRefreshThresholdMs() / 1000))
    ) // seconds
    const expiresIn = tokens.expires_in ?? 0
    if (expiresIn < MIN_EXPIRES_IN) {
      // Production telemetry: filter on alert="short_expires_in" in Cloud Logging
      // to detect Google returning sub-threshold tokens.  Each occurrence forces a
      // user re-auth; a spike here indicates Google token-endpoint misbehavior.
      log.warn("Google token refresh returned unexpectedly short expires_in — treating as failure", {
        expiresIn,
        minExpected: MIN_EXPIRES_IN,
        alert: "short_expires_in",
      })
      return null
    }

    const refreshed: JWT = {
      ...token,
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      // Google may rotate the refresh token on security events — preserve the
      // new one when present; fall back to the existing token otherwise.
      // Using `||` (not `??`) so an empty-string rotation result is also treated
      // as absent — Google shouldn't return `""`, but `||` is free defense-in-depth.
      refreshToken: tokens.refresh_token || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    }

    // Fail-closed: the `refreshToken: tokens.refresh_token || refreshToken`
    // chain above should always produce a non-empty string (token.refreshToken is
    // null-guarded at the top of doRefresh and extracted to `refreshToken`).  But if both
    // somehow resolve to undefined / empty-string (e.g. a future refactor removes
    // the early return), storing an absent refresh token would cause a silent
    // auth failure on the *next* expiry without any visible error.  Return null
    // here so the caller forces re-authentication immediately rather than letting
    // a broken token persist in the cookie.
    if (!refreshed.refreshToken) {
      log.warn("Token refresh produced a result with no refreshToken — returning null (fail-closed)", {
        sub: token.sub,
        hadOriginalRefreshToken: !!token.refreshToken,
        googleReturnedRefreshToken: !!tokens.refresh_token,
      })
      return null
    }

    log.info("Google token refreshed successfully")
    return refreshed
  } catch (error) {
    // AbortError means our 10 s timeout fired — log as warn, not error,
    // since this is an expected failure path (upstream latency spike).
    if (error instanceof Error && error.name === 'AbortError') {
      log.warn("Google token refresh timed out after 10 s — returning null (fail-closed)")
      return null
    }
    log.error("Google token refresh threw error", {
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return null
  } finally {
    // Always clear the abort timer so it doesn't fire after the fetch settles.
    clearTimeout(fetchTimeout)
  }
}
