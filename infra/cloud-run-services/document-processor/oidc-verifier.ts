/**
 * OIDC ID-token verifier for inbound Cloud Tasks / Cloud Scheduler dispatches.
 *
 * Cloud Tasks signs each outbound HTTP request with a Google-issued ID token
 * (RS256, iss=https://accounts.google.com). Receivers must verify the
 * signature, audience, and the `email` claim — without the email check, any
 * service account in the project that gains `roles/run.invoker` could fire
 * tasks at us.
 *
 * We pin the JWKS URL to Google's public certs and cache the keyset for the
 * default 5-minute window jose's createRemoteJWKSet provides.
 */

import { jwtVerify, createRemoteJWKSet } from "jose"

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
)

export interface VerifyOptions {
  /** Expected `aud` claim — the absolute URL Cloud Tasks dispatched to. */
  audience: string
  /** Expected `email` claim — the SA email we configured in oidcToken. */
  expectedEmail: string
}

/**
 * Verify a Bearer token from an inbound request.
 *
 * Returns the decoded token claims on success; throws otherwise. Errors are
 * intentionally generic — handlers should map them to 401 without echoing
 * the underlying jose error to the wire.
 */
export async function verifyOidcToken(
  authHeader: string | undefined,
  opts: VerifyOptions,
): Promise<{ email: string; sub: string; aud: string; iss: string }> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw new Error("missing or malformed Authorization header")
  }
  const token = authHeader.slice(7).trim()
  if (token.length === 0) {
    throw new Error("missing or malformed Authorization header")
  }

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: opts.audience,
    algorithms: ["RS256"],
  })

  if (payload.email !== opts.expectedEmail) {
    throw new Error(
      `email claim mismatch: expected "${opts.expectedEmail}", got "${
        typeof payload.email === "string" ? payload.email : "<missing>"
      }"`,
    )
  }

  if (payload.email_verified !== true) {
    throw new Error("email_verified claim is not true")
  }

  return {
    email: payload.email,
    sub: typeof payload.sub === "string" ? payload.sub : "",
    aud: typeof payload.aud === "string" ? payload.aud : "",
    iss: typeof payload.iss === "string" ? payload.iss : "",
  }
}
