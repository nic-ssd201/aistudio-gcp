import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import type { NextAuthConfig } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { createLogger } from "@/lib/auth/edge-logger"
import { refreshGoogleToken } from "@/lib/auth/refresh-google-token"
import { hasVerifiedGoogleEmail } from "@/lib/auth/google-email-guard"

export const authConfig: NextAuthConfig = {
  providers: [
    // Google OIDC — sole auth provider for SSD201 GCP deployment.
    // access_type: "offline" gets a refresh_token so sessions outlive the
    // initial 1-hour access token. prompt: "consent" ensures Google always
    // returns a refresh_token (even on repeat sign-ins).
    //
    // No hd (hosted-domain) restriction: access control is enforced downstream
    // by the role/permission system (hasToolAccess). Add hd here if you need
    // to gate sign-in to a specific Workspace domain.
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      authorization: {
        params: {
          scope: "openid email profile",
          access_type: "offline",
          // `prompt: "consent"` ensures Google returns a refresh_token on
          // every sign-in (including repeat sign-ins for the same user).
          // Without it, Google only issues a refresh_token on the first
          // authorization for a given client+scope — subsequent logins may
          // omit it, leaving the session unable to extend beyond 1 hour.
          // Trade-off: users see the Google consent screen on every sign-in
          // instead of silent SSO. Change to "select_account" if account
          // picking without full consent re-prompt is preferred and the
          // missing-refresh-token case can be handled (e.g., redirect to
          // re-auth when expiresAt approaches without a refresh_token).
          prompt: "consent",
        },
      },
      checks: ["pkce", "state", "nonce"],
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name || profile.given_name || profile.family_name,
          email: profile.email,
          image: profile.picture,
          given_name: profile.given_name,
          family_name: profile.family_name,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile, user, trigger }) {
      const log = createLogger({
        context: "auth-jwt-callback",
        tokenSub: token?.sub as string || 'unknown'
      })

      // Handle session update trigger (when roles change).
      // Decision: fail-closed — return null to force full re-authentication.
      // Rationale: this codebase uses /api/auth/refresh-session (clears the
      // session cookie and redirects to sign-in) for role-change propagation;
      // `useSession().update()` is not called anywhere. If that ever changes,
      // fail-closed remains the correct behaviour for demotion/revocation —
      // better to re-auth once than to serve a stale high-privilege token.
      if (trigger === "update") {
        log.info("Session update triggered — forcing re-authentication (fail-closed)")
        return null;
      }

      // Initial sign in - store essential data
      if (account && account.id_token) {
        log.info("Initial sign in - processing new tokens", {
          hasAccessToken: !!account.access_token,
          hasRefreshToken: !!account.refresh_token,
          hasIdToken: !!account.id_token,
          expiresAt: account.expires_at ? new Date(account.expires_at * 1000).toISOString() : 'unknown'
        })

        try {
          // SECURITY NOTE: This JWT parsing is safe here because the id_token comes directly
          // from the OAuth provider (Google) during the callback flow and has already
          // been validated by NextAuth — signature verified via JWKS before reaching this callback.
          // DO NOT use this pattern for parsing JWTs from untrusted sources or user input.
          // For untrusted JWTs, always use proper JWT verification libraries like 'jose'.
          const base64Payload = account.id_token.split('.')[1];
          const payload = Buffer.from(base64Payload, 'base64').toString('utf-8');
          const decoded = JSON.parse(payload);

          const issuedAt = decoded.iat ? decoded.iat * 1000 : Date.now()
          const expiresAt = account.expires_at ? account.expires_at * 1000 : Date.now() + (60 * 60 * 1000) // 1 hour fallback — matches Google's access-token lifetime

          log.debug("Token lifetime information", {
            issuedAt: new Date(issuedAt).toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            tokenLifetimeHours: Math.round((expiresAt - issuedAt) / (1000 * 60 * 60)),
            googleProvidedExpiry: !!account.expires_at
          })

          const newToken: JWT = {
            sub: decoded.sub,
            email: decoded.email,
            name: decoded.name || decoded.given_name || decoded.preferred_username || decoded.email,
            given_name: decoded.given_name,
            family_name: decoded.family_name,
            preferred_username: decoded.preferred_username,
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            idToken: account.id_token,
            expiresAt: expiresAt,
            iat: decoded.iat,
            roleVersion: 0, // Initialize role version
            provider: 'google', // Always Google for SSD201
          }

          log.info("Successfully created initial token", {
            sub: newToken.sub,
            email: newToken.email,
            expiresAt: newToken.expiresAt ? new Date(newToken.expiresAt).toISOString() : 'unknown'
          })

          return newToken
        } catch (error) {
          // Log error but don't fail authentication
          // This handles malformed tokens gracefully
          log.warn("Failed to parse ID token, using fallback approach", {
            error: error instanceof Error ? error.message : 'Unknown error'
          })

          const now = Date.now()
          const expiresAt = account.expires_at ? account.expires_at * 1000 : now + (60 * 60 * 1000) // 1 hour fallback — matches Google's access-token lifetime

          // Carry given_name / family_name from `user` or `profile` so the
          // session-callback name chain (token.given_name || token.name || …)
          // has the same fields available on the fallback path as on the happy path.
          // Note: `iat` and `preferred_username` are intentionally omitted here
          // because they come from the id_token payload that failed to parse —
          // using account.providerAccountId as sub is already a best-effort fallback.
          const fallbackToken: JWT = {
            sub: account.providerAccountId,
            email: user?.email || profile?.email || undefined,
            name: user?.name || profile?.name || undefined,
            given_name: (profile as { given_name?: string } | undefined)?.given_name || undefined,
            family_name: (profile as { family_name?: string } | undefined)?.family_name || undefined,
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            idToken: account.id_token,
            expiresAt: expiresAt,
            roleVersion: 0,
            provider: 'google', // Always Google for SSD201
          };

          log.info("Created fallback token", {
            sub: fallbackToken.sub,
            email: fallbackToken.email
          })

          return fallbackToken
        }
      }

      // Existing session - check if token needs refresh
      if (!token.expiresAt) {
        log.warn("Token missing expiration time, allowing to continue")
        return token
      }

      const expiresAt = token.expiresAt as number
      const now = Date.now()
      const isExpired = now > expiresAt

      // Proactively refresh when less than REFRESH_THRESHOLD_MS remain.
      // Default: 5 minutes — conservative for normal web requests. Override via
      // TOKEN_REFRESH_THRESHOLD_MS (milliseconds) if long-running streaming or
      // scheduled-execution paths take >5 min between JWT-callback invocations.
      // Floor: 60 s — prevents accidentally disabling proactive refresh.
      const envThreshold = Number.parseInt(process.env.TOKEN_REFRESH_THRESHOLD_MS ?? '', 10)
      const REFRESH_THRESHOLD_MS = Number.isFinite(envThreshold) && envThreshold >= 60_000
        ? envThreshold
        : 5 * 60 * 1000
      const shouldRefresh = (expiresAt - now) < REFRESH_THRESHOLD_MS

      log.debug("Token status check", {
        isExpired,
        shouldRefresh,
        timeUntilExpiryMinutes: Math.round((expiresAt - now) / (1000 * 60)),
        expiresAt: new Date(expiresAt).toISOString()
      })

      if (isExpired || shouldRefresh) {
        log.info("Attempting Google token refresh", {
          reason: isExpired ? 'expired' : 'proactive',
          hasRefreshToken: !!token.refreshToken,
        })

        if (!token.refreshToken) {
          log.warn("No refresh token available - forcing re-authentication")
          return null
        }

        try {
          const refreshed = await refreshGoogleToken(token)

          if (refreshed) {
            log.info("Token refresh successful", {
              newExpiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt).toISOString() : 'unknown',
            })
            return refreshed
          } else {
            log.warn("Token refresh failed - forcing re-authentication")
            return null
          }
        } catch (error) {
          log.error("Token refresh threw error - forcing re-authentication", {
            error: error instanceof Error ? error.message : 'Unknown error'
          })
          return null
        }
      }

      // Token is still valid, return as-is
      log.debug("Token is valid, no refresh needed")
      return token;
    },
    async session({ session, token }) {
      const log = createLogger({
        context: "auth-session-callback",
        tokenSub: token?.sub as string || 'unknown'
      })

      // Check if token exists and is valid
      if (!token || !token.sub) {
        log.warn("Session callback called with invalid token")
        return session; // Return empty session instead of null
      }

      // Check if token is expired (shouldn't happen after JWT callback refresh logic)
      if (token.expiresAt && Date.now() > (token.expiresAt as number)) {
        log.warn("Session callback received expired token - returning empty session", {
          expiresAt: new Date(token.expiresAt as number).toISOString(),
          now: new Date().toISOString()
        })
        // Return an empty session to force re-authentication
        return {
          ...session,
          user: {
            id: '',
            email: '',
            name: '',
            givenName: null,
            familyName: null
          },
          accessToken: '',
          idToken: '',
        }
      }

      // Send properties to the client
      const givenName = token.given_name as string;
      const familyName = token.family_name as string;
      const fullName = token.name as string;
      const preferredUsername = token.preferred_username as string;
      const email = token.email as string;

      // Use given_name as display name, with multiple fallbacks
      const displayName = givenName || fullName || preferredUsername || familyName || email;

      session.user = {
        ...session.user,
        id: token.sub as string,
        email: email,
        name: displayName,
        givenName: givenName || null,
        familyName: familyName || null,
      }

      // Store tokens in session for server-side use.
      // NOTE: refreshToken is intentionally kept on the JWT only (not exposed
      // here) — it is only needed server-side inside the jwt() callback to
      // obtain a new access/id token and should not be reachable via useSession().
      //
      // Security considerations:
      // - These tokens are encrypted in the NextAuth JWT session cookie
      // - accessToken: used for server-side Google API calls
      // - idToken: contains OIDC user claims for identity verification
      // - Never log or expose these tokens in client-side code
      session.accessToken = token.accessToken as string;
      session.idToken = token.idToken as string;

      log.debug("Session created successfully", {
        userId: session.user.id,
        userEmail: session.user.email,
        hasAccessToken: !!session.accessToken,
        hasIdToken: !!session.idToken,
        tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt as number).toISOString() : 'unknown'
      })

      return session
    },
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`
      // Allows callback URLs on the same origin. Both sides are normalised to
      // .origin so a trailing-slash AUTH_URL (e.g. "https://app.example.com/")
      // still matches correctly. Wrapped in try/catch because new URL() throws
      // on malformed strings (e.g. "not-a-url", "javascript:alert(1)") — any
      // such string falls through to the safe /dashboard default.
      try {
        if (new URL(url).origin === new URL(baseUrl).origin) return url
      } catch {
        // Malformed URL — fall through to safe default below.
      }
      return baseUrl + "/dashboard"
    },
    async signIn({ account, profile }) {
      // Reject sign-ins from Google accounts with unverified emails.
      // hasVerifiedGoogleEmail uses `=== true` so absent/stringified/"false"
      // claims all fail — defense-in-depth against resolveUserId's email-fallback
      // path potentially fusing an unverified account into an existing user record.
      //
      // The `account?.provider === 'google'` guard is intentionally kept even though
      // Google is the only registered provider. It ensures this check is skipped
      // automatically if a future provider (e.g. GitHub) is added without its own
      // email_verified gate — rather than incorrectly rejecting it here.
      if (account?.provider === 'google' && !hasVerifiedGoogleEmail(profile)) {
        const log = createLogger({ context: "auth-signin-callback" })
        // Mask the local-part before logging — email is PII even in warn logs.
        // Capture only the first character so short local-parts (≤3 chars) are
        // also masked (e.g. "abc@x.com" → "a***@x.com" not "abc***@x.com").
        const maskedEmail = profile?.email
          ? profile.email.replace(/^(.).*(@.*)$/, '$1***$2')
          : undefined
        log.warn("Sign-in rejected: Google email not verified", {
          email: maskedEmail,
          emailVerified: profile?.email_verified,
        })
        return false;
      }
      return true;
    },
  },
  pages: {
    // We'll use the default NextAuth pages for now
    // Can customize later if needed
    error: "/auth/error",
  },
  session: {
    strategy: "jwt",
    // Session max age in seconds (default: 24 hours)
    maxAge: (() => {
      const parsed = Number.parseInt(process.env.SESSION_MAX_AGE ?? '', 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 24 * 60 * 60
    })(),
  },
  cookies: {
    sessionToken: {
      name: `authjs.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    callbackUrl: {
      name: `authjs.callback-url`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    csrfToken: {
      name: `authjs.csrf-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
    pkceCodeVerifier: {
      name: `authjs.pkce.code_verifier`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 15 // 15 minutes
      }
    },
    state: {
      name: `authjs.state`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 15 // 15 minutes
      }
    },
    nonce: {
      name: `authjs.nonce`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production'
      }
    },
  },
  debug: false, // Disabled to suppress CHUNKING_SESSION_COOKIE warnings (#361)
  events: {
    async signOut() {
      // This event fires after NextAuth's signOut
      // We can use this for any cleanup needed
      // User signed out
    },
  },
}

// Factory function - creates new instance per request
export function createAuth() {
  return NextAuth(authConfig)
}

// For middleware only - stateless operations
// This is safe because middleware doesn't maintain user-specific state
const middlewareAuth = NextAuth(authConfig)
export const { auth: authMiddleware } = middlewareAuth

// Export auth handlers for route.ts files
// These need to be created per-request in the route handlers
export function createAuthHandlers() {
  const { handlers } = createAuth()
  return handlers
}