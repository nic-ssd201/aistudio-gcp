import NextAuth from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      /**
       * Google OIDC subject identifier — the stable unique ID for this Google account.
       * Optional because the session callback can return the session without setting
       * `user.id` in the absent-email bypass path (stale pre-guard JWT).  In that
       * case `getServerSession()` treats the session as unauthenticated via
       * `if (!session?.user?.id) return null`.  Callers that reach code past that
       * guard can safely assume `id` is a non-empty string (TypeScript narrows it
       * from `string | undefined` to `string` via the truthy check).
       */
      id?: string
      /**
       * Google OIDC email address.  Optional for the same reason as `id` — the
       * absent-email session-callback bypass returns the session without assigning
       * `user.email`.  All downstream code that needs a verified email should
       * guard on `session?.user?.email` or operate only after `getServerSession()`
       * confirms the session is valid (id present).
       */
      email?: string
      name?: string | null
      image?: string | null
      givenName?: string | null
      familyName?: string | null
    }
    // Token propagation policy (see auth.ts session callback):
    // - refreshToken: JWT-only — not exposed on Session.
    // - accessToken: JWT-only — no consumer reads session.accessToken, keeping
    //   it off the session reduces accidental client-side exposure.
    // - idToken: propagated for MCP connector session-passthrough auth.
    idToken?: string
    /** Login-time issued-at (seconds since epoch). Propagated from token.loginIat
     *  so the polling cache can key on sub+loginIat and avoid returning a stale role
     *  set when a user re-authenticates within the 5-min TTL window.
     *  Named loginIat (not iat) to distinguish from NextAuth's own standard `iat`
     *  claim, which jose.EncryptJWT resets on every re-encode. */
    loginIat?: number
    /** Role version counter from the JWT, compared against the DB value by
     *  /api/auth/refresh-session to detect role changes and trigger re-auth.
     *  Without propagation sessionRoleVersion is always undefined (→ 0), causing
     *  needsRefresh=true on every poll after the first role change. */
    roleVersion?: number
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string
    idToken?: string
    refreshToken?: string
    expiresAt?: number
    sub?: string
    email?: string
    name?: string
    given_name?: string
    family_name?: string
    preferred_username?: string
    /** Auth provider — always 'google' for SSD201 GCP deployment. */
    provider?: 'google'
    roleVersion?: number
    /** Stable login-time marker (seconds since epoch). Set once at sign-in from
     *  the Google OIDC id_token's iat claim and never overwritten by NextAuth's
     *  internal re-encode step (jose.EncryptJWT.setIssuedAt() only touches the
     *  standard `iat` claim, not custom fields). Propagated to Session.loginIat so
     *  the polling cache can key on sub+loginIat for stable hits. */
    loginIat?: number
  }
}