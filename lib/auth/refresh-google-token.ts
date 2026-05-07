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
 */
const activeRefreshes = new Map<string, Promise<JWT | null>>()

export async function refreshGoogleToken(token: JWT): Promise<JWT | null> {
  const log = createLogger({ context: "google-token-refresh" })
  // "anonymous" is a safe fallback: doRefresh short-circuits on missing
  // refreshToken before doing any network I/O, so two anonymous calls sharing
  // a Promise just both get null quickly — no correctness impact.
  const sub = (token.sub as string | undefined) ?? "anonymous"

  // Deduplicate concurrent refresh calls for the same user.
  const existing = activeRefreshes.get(sub)
  if (existing) {
    log.debug("Joining existing in-flight token refresh", { sub })
    return existing
  }

  const promise = doRefresh(token, log).finally(() => {
    activeRefreshes.delete(sub)
  })
  activeRefreshes.set(sub, promise)
  return promise
}

async function doRefresh(token: JWT, log: ReturnType<typeof createLogger>): Promise<JWT | null> {

  if (!token.refreshToken) {
    log.warn("No refresh token available for Google token", { sub: token.sub })
    return null
  }

  // Return null (not throw) when the secret is absent — the misconfiguration
  // is already surfaced by validateEnv() at startup and flagged in auth.ts at
  // initial sign-in time (no Google provider is registered without the secret).
  const secret = process.env.AUTH_GOOGLE_SECRET
  if (!secret) {
    log.error("AUTH_GOOGLE_SECRET is not set — cannot refresh Google token")
    return null
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.AUTH_GOOGLE_ID ?? "",
        client_secret: secret,
        refresh_token: token.refreshToken as string,
      }),
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

    const refreshed: JWT = {
      ...token,
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      // Google may rotate the refresh token on security events — preserve the
      // new one when present; fall back to the existing token otherwise.
      refreshToken: tokens.refresh_token ?? token.refreshToken,
      // `?? 3600` handles a missing expires_in (default 1 hour).
      // `Math.max(..., 60)` is a floor guard — 60 s is not the default, just
      // the minimum allowed so a zero/malformed value doesn't cause an
      // immediate re-refresh loop. Google's normal value is 3600 s.
      expiresAt: Date.now() + Math.max(tokens.expires_in ?? 3600, 60) * 1000,
    }

    log.info("Google token refreshed successfully")
    return refreshed
  } catch (error) {
    log.error("Google token refresh threw error", {
      error: error instanceof Error ? error.message : "Unknown error",
    })
    return null
  }
}
