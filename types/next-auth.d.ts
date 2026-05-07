import NextAuth from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
      image?: string | null
      givenName?: string | null
      familyName?: string | null
    }
    // Add token properties to session for server-side use.
    // refreshToken is intentionally excluded — it lives only on the JWT,
    // not in the client-visible session object.
    accessToken?: string
    idToken?: string
    /** Login-time issued-at (seconds since epoch). Propagated from token.loginIat
     *  so the polling cache can key on sub+iat and avoid returning a stale role
     *  set when a user re-authenticates within the 5-min TTL window.
     *  NOTE: populated from token.loginIat (not token.iat) because NextAuth's
     *  jose.EncryptJWT resets the standard iat claim on every re-encode. */
    iat?: number
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
     *  standard `iat` claim, not custom fields). Propagated to Session.iat so the
     *  polling cache can key on sub+loginIat for stable hits. */
    loginIat?: number
  }
}