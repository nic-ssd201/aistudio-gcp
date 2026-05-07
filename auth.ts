import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import type { NextAuthConfig } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { createLogger } from "@/lib/auth/edge-logger"
import { refreshGoogleToken } from "@/lib/auth/refresh-google-token"

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
          prompt: "consent", // Required to receive refresh_token on every sign-in
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

      // Handle session update trigger (when roles change)
      if (trigger === "update") {
        log.info("Session update triggered - forcing re-authentication")
        // Force token refresh by returning null
        // This will cause the user to re-authenticate
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

        // Calculate token lifetime for accurate refresh timing
        const issuedAt = decoded.iat ? decoded.iat * 1000 : Date.now()
        const expiresAt = account.expires_at ? account.expires_at * 1000 : Date.now() + (12 * 60 * 60 * 1000) // 12 hours fallback
        const tokenLifetimeMs = expiresAt - issuedAt

        // Enhanced logging for token lifecycle debugging
        log.debug("Token lifetime information", {
          issuedAt: new Date(issuedAt).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          tokenLifetimeHours: Math.round(tokenLifetimeMs / (1000 * 60 * 60)),
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
          tokenLifetimeMs: tokenLifetimeMs, // Store calculated lifetime for accurate refresh timing
          roleVersion: 0, // Initialize role version
          provider: 'google', // Always Google for SSD201
        };

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
          const expiresAt = account.expires_at ? account.expires_at * 1000 : now + (12 * 60 * 60 * 1000) // 12 hours fallback
          const tokenLifetimeMs = 12 * 60 * 60 * 1000 // 12 hours

          const fallbackToken: JWT = {
            sub: account.providerAccountId,
            email: user?.email || profile?.email || undefined,
            name: user?.name || profile?.name || undefined,
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            idToken: account.id_token,
            expiresAt: expiresAt,
            tokenLifetimeMs: tokenLifetimeMs,
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

      // Proactively refresh when less than 5 minutes remain (avoids mid-request expiry)
      const fiveMinutes = 5 * 60 * 1000
      const shouldRefresh = (expiresAt - now) < fiveMinutes

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
          refreshToken: ''
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

      // Store tokens in session for server-side use
      // NOTE: These tokens are necessary for:
      // - accessToken: Making authenticated API calls to AWS services
      // - idToken: Contains user claims and is used for identity verification
      // - refreshToken: Required for token refresh when accessToken expires
      //
      // Security considerations:
      // - These tokens are encrypted in the JWT session cookie
      // - Never log or expose these tokens in client-side code
      // - Consider implementing token rotation for enhanced security
      session.accessToken = token.accessToken as string;
      session.idToken = token.idToken as string;
      session.refreshToken = token.refreshToken as string;

      log.debug("Session created successfully", {
        userId: session.user.id,
        userEmail: session.user.email,
        hasAccessToken: !!session.accessToken,
        hasIdToken: !!session.idToken,
        hasRefreshToken: !!session.refreshToken,
        tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt as number).toISOString() : 'unknown'
      })

      return session
    },
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith("/")) return `${baseUrl}${url}`
      // Allows callback URLs on the same origin
      else if (new URL(url).origin === baseUrl) return url
      return baseUrl + "/dashboard"
    },
    async signIn() {
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
    maxAge: process.env.SESSION_MAX_AGE ? Number.parseInt(process.env.SESSION_MAX_AGE) : 24 * 60 * 60,
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