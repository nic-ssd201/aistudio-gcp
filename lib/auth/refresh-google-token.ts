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
import { getRefreshThresholdMs } from "@/lib/auth/token-refresh-config"

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
 * the same instant — negligible in practice. An explicit 500-entry safety cap
 * is applied before each insertion as a defense-in-depth measure against
 * unexpected horizontal-scaling scenarios (see guard below).
 */
const activeRefreshes = new Map<string, Promise<JWT | null>>()

/**
 * Minimum acceptable `expires_in` (seconds) returned by Google's token endpoint.
 *
 * Computed once at module load so every call to doRefresh() reads a module-level
 * constant rather than re-parsing TOKEN_REFRESH_THRESHOLD_MS on every request.
 * The value is stable for the lifetime of the process (env vars don't change at
 * runtime), so caching is safe.
 *
 * Math.max(300, …) is an absolute lower bound independent of operator config:
 * Google's documented access-token lifetime is 3600 s, so < 300 s is structurally
 * abnormal regardless of the threshold setting.  See the check inside doRefresh()
 * for full rationale.
 */
const MIN_EXPIRES_IN = Math.max(300, Math.round(getRefreshThresholdMs() / 1000)) // seconds

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

  // Keying on sub alone assumes one browser session = one refreshToken per sub,
  // which is true in practice (NextAuth issues one JWT cookie per session, and
  // Google only rotates the refresh token occasionally). If two concurrent callers
  // somehow held different refresh tokens for the same sub, the second caller's
  // token would be silently dropped — but this cannot happen within a single
  // JWT session since all callers share the same cookie.

  // Deduplicate concurrent refresh calls for the same user.
  const existing = activeRefreshes.get(sub)
  if (existing) {
    log.debug("Joining existing in-flight token refresh", { sub })
    return existing
  }

  // Safety cap: if the map grows unexpectedly large (500+ distinct subs all
  // refreshing simultaneously — theoretical but not impossible in horizontal-
  // scaling scenarios), bypass dedup for this call rather than clearing the
  // whole map.  Clearing would evict in-flight Promises without aborting the
  // underlying fetches, creating a dedup gap where a follow-up call could race
  // the orphaned fetch.  Bypassing dedup is safer: the in-flight entries are
  // left intact and no race is introduced.  The cost is that N concurrent
  // callers for the same sub each issue an independent refresh fetch (N fetches
  // rather than 1), and each subsequent caller races the first one's
  // refresh_token rotation — an acceptable risk at 500+ subs where the dedup
  // benefit is already marginal.
  if (activeRefreshes.size >= 500) {
    log.warn("activeRefreshes map at capacity (≥500 entries) — bypassing dedup for this call; should be rare in production — investigate if persistent", {
      size: activeRefreshes.size,
      sub,
    })
    return doRefresh(token, log)
  }

  // Use an identity check rather than a plain delete so that a concurrent
  // insertion for the same sub between the .finally() binding and when it fires
  // cannot accidentally remove the new promise. (The safety cap above bypasses
  // rather than evicts, so eviction-race is not the threat today — but the
  // identity check is cheap defense-in-depth for any future change to the cap.)
  const promise = doRefresh(token, log).finally(() => {
    if (activeRefreshes.get(sub) === promise) {
      activeRefreshes.delete(sub)
    }
  })
  activeRefreshes.set(sub, promise)
  return promise
}

async function doRefresh(token: JWT, log: ReturnType<typeof createLogger>): Promise<JWT | null> {

  if (!token.refreshToken) {
    log.warn("No refresh token available for Google token", { sub: token.sub })
    return null
  }

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
        refresh_token: token.refreshToken as string,
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
    // MIN_EXPIRES_IN is the module-level constant (cached at load time) derived
    // from max(300, TOKEN_REFRESH_THRESHOLD_MS / 1000).  An operator who raises
    // the threshold above the default 300 s still gets the higher value enforced,
    // preventing the hot-loop for tokens whose expires_in falls between 300 s and
    // their custom threshold.
    const expiresIn = tokens.expires_in ?? 0
    if (expiresIn < MIN_EXPIRES_IN) {
      log.warn("Google token refresh returned unexpectedly short expires_in — treating as failure", {
        expiresIn,
        minExpected: MIN_EXPIRES_IN,
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
      refreshToken: tokens.refresh_token || token.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    }

    // Fail-closed: the `refreshToken: tokens.refresh_token || token.refreshToken`
    // chain above should always produce a non-empty string (token.refreshToken is
    // checked for presence at line 122 before reaching doRefresh).  But if both
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
