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
    tokenLifetimeMs?: number
    roleVersion?: number
  }
}