import NextAuth from "next-auth"
import Google, { type GoogleProfile } from "next-auth/providers/google"
import type { NextAuthConfig } from "next-auth"
import type { JWT } from "next-auth/jwt"
import { createLogger } from "@/lib/auth/edge-logger"
import { refreshGoogleToken } from "@/lib/auth/refresh-google-token"
import { hasVerifiedGoogleEmail } from "@/lib/auth/google-email-guard"
import { getRefreshThresholdMs, getSessionMaxAgeSecs } from "@/lib/auth/token-refresh-config"

// AUTH_GOOGLE_FORCE_CONSENT: single parse shared by the startup log and the
// provider prompt selection below.  Three previously-independent reads of the
// same env var with the same `.toLowerCase() === 'false'` logic are replaced
// by this one derived value.
//
// Trim before lowercasing so a stray-space value like " false" does not silently
// default to consent mode — consistent with the .trim() applied to Google-creds
// and DB-config vars in lib/env-validation.ts.
// Default is true (consent mode) when the var is absent or unrecognised — this
// is also enforced by the env-validation startup warning in lib/env-validation.ts.
const googleForceConsent = process.env.AUTH_GOOGLE_FORCE_CONSENT?.trim().toLowerCase() !== 'false'

// Log the effective Google prompt mode at module load so operators can confirm
// what they actually got (consent vs select_account) without reading source code.
// Edge-logger is safe here — auth.ts runs in both Edge and Node runtimes.
{
  const log = createLogger({ context: 'auth-config' })
  const effectivePrompt = googleForceConsent ? 'consent' : 'select_account'
  log.info(`Google OAuth prompt mode: "${effectivePrompt}"`, {
    AUTH_GOOGLE_FORCE_CONSENT: process.env.AUTH_GOOGLE_FORCE_CONSENT ?? '(unset — defaulting to consent)',
  })
}

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
          // `prompt` controls whether Google shows the consent screen on repeat sign-ins.
          //
          // "consent" (default when AUTH_GOOGLE_FORCE_CONSENT=true or unset):
          //   Google always returns a refresh_token. Users see the consent dialog on
          //   every sign-in — a UX cost, but guarantees long-lived sessions.
          //
          // "select_account" (when AUTH_GOOGLE_FORCE_CONSENT=false):
          //   Google shows an account-picker but re-uses an existing grant, so it
          //   may not return a refresh_token on repeat logins. Handle the missing
          //   refresh_token case (e.g. redirect to re-auth when expiresAt nears
          //   without a refreshToken) before enabling this in production.
          //
          // Default: "consent" — set AUTH_GOOGLE_FORCE_CONSENT=false to opt out.
          // Comparison is case-insensitive; see googleForceConsent at module top.
          prompt: googleForceConsent ? 'consent' : 'select_account',
        },
      },
      checks: ["pkce", "state", "nonce"],
      profile(profile) {
        return {
          id: profile.sub,
          // `||` collapses empty-string `name` values to `given_name`/`family_name`.
          // Intentional: Google occasionally returns `name: ""` for service accounts.
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
        tokenSub: String(token?.sub ?? 'unknown')
      })

      // Handle session update trigger (when roles change).
      // Decision: fail-closed — return null to force full re-authentication.
      // Rationale: this codebase uses /api/auth/refresh-session (clears the
      // session cookie and redirects to sign-in) for role-change propagation;
      // `useSession().update()` is not called anywhere. If that ever changes,
      // fail-closed remains the correct behaviour for demotion/revocation —
      // better to re-auth once than to serve a stale high-privilege token.
      //
      // GREP GUARD: verify `useSession().update()` is not called before relaxing
      // this branch. Run: grep -r "useSession" . --include="*.ts" --include="*.tsx" | grep "\.update("
      // Any hit means a client is calling update() and every such call will silently
      // log all affected users out. Audit before removing this comment.
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
          // @see https://authjs.dev/reference/core/providers#provider-callbacks (NextAuth v5 docs)
          //      confirming that the jwt() callback fires after the provider's id_token is verified.
          // DO NOT use this pattern for parsing JWTs from untrusted sources or user input.
          // For untrusted JWTs, always use proper JWT verification libraries like 'jose'.
          //
          // atob() instead of Buffer.from(): this branch only runs during the OAuth
          // callback (account is only present on initial sign-in), which is handled
          // by the /api/auth/callback/* Node.js route — never by Edge middleware.
          // We use atob() anyway for correctness: it is available in both runtimes
          // (Node 16+ / all Edge environments), removing any runtime dependency on
          // the Node-only Buffer API and keeping auth.ts safe to import from Edge.
          // base64url → base64: replace URL-safe chars before decoding.
          const base64Payload = account.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = atob(base64Payload);
          const decoded = JSON.parse(payload);

          // Use `??` (not `?`) so iat=0 (Unix epoch) is treated as present — consistent
          // with `loginIat: decoded.iat ?? …` below.  A truthiness check (`?`) would
          // silently fall back to Date.now() for a valid-but-zero iat.
          const issuedAt = (decoded.iat ?? Math.floor(Date.now() / 1000)) * 1000
          const expiresAt = account.expires_at ? account.expires_at * 1000 : Date.now() + (60 * 60 * 1000) // 1 hour fallback — matches Google's access-token lifetime

          log.debug("Token lifetime information", {
            issuedAt: new Date(issuedAt).toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            tokenLifetimeHours: Math.round((expiresAt - issuedAt) / (1000 * 60 * 60)),
            googleProvidedExpiry: !!account.expires_at
          })

          // Warn when Google does not return a refresh_token on initial sign-in.
          // This happens in select_account mode (AUTH_GOOGLE_FORCE_CONSENT=false)
          // when the user has already granted offline_access and Google skips the
          // consent screen — if no refresh_token is issued, the session will end
          // silently at access-token expiry (auth.ts jwt() callback returns null).
          // Operators should see this in logs and consider switching to consent mode
          // or ensuring the prompt parameter forces a new grant.
          if (!account.refresh_token) {
            log.warn("Initial sign-in: no refresh_token returned by Google — session will end at access-token expiry", {
              sub: decoded.sub,
              prompt: googleForceConsent ? 'consent' : 'select_account',
            })
          }

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
            // loginIat is our stable login-time marker.  NextAuth's jose.EncryptJWT
            // calls .setIssuedAt() on every encode which overwrites the standard `iat`
            // claim to the current timestamp.  Keying the polling cache on `iat` would
            // therefore produce a fresh cache key on every re-encode (permanent miss).
            // loginIat is a custom claim that NextAuth never touches, so it stays
            // constant for the lifetime of the login session and gives the cache a
            // stable key to hit.  See lib/auth/polling-session-cache.ts.
            // `??` not `||`: iat=0 is theoretically valid (Unix epoch) and
            // should be preserved as-is in the token rather than overwritten by a
            // synthetic fallback. The cache layer (generateSessionCacheKey) treats
            // iat=0 as absent — skip-caching rather than storing under the
            // degenerate key session:sub:0 — because Google never actually issues
            // iat=0 in production and caching under that key would risk
            // cross-session collisions for all zero-iat tokens of the same sub.
            // The two layers are intentionally consistent: preserve the real value
            // in the token, reject the pathological value in the cache.
            loginIat: decoded.iat ?? Math.floor(Date.now() / 1000),
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
          // log.error (not warn): malformed id_tokens from Google are unexpected
          // and should be visible in production telemetry — they may indicate
          // a token-integrity problem or a security event worth investigating.
          log.error("Failed to parse ID token, using fallback approach", {
            error: error instanceof Error ? error.message : 'Unknown error'
          })

          const now = Date.now()
          const expiresAt = account.expires_at ? account.expires_at * 1000 : now + (60 * 60 * 1000) // 1 hour fallback — matches Google's access-token lifetime

          // Carry given_name / family_name from `user` or `profile` so the
          // session-callback name chain (token.given_name || token.name || …)
          // has the same fields available on the fallback path as on the happy path.
          // Note: `preferred_username` is intentionally omitted — it comes from the
          // id_token payload that failed to parse.
          // `iat` falls back to Math.floor(Date.now()/1000) so each fallback session
          // gets a distinct cache key (session:sub:iat) rather than the default
          // session:sub:0 that all sub-less fallback sessions would otherwise share.
          // Cast to the exported GoogleProfile type (not an ad-hoc structural type).
          const p = profile as GoogleProfile | undefined
          const fallbackToken: JWT = {
            sub: account.providerAccountId,
            email: user?.email || profile?.email || undefined,
            name: user?.name || profile?.name || undefined,
            given_name: p?.given_name || undefined,
            family_name: p?.family_name || undefined,
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            idToken: account.id_token,
            expiresAt: expiresAt,
            loginIat: Math.floor(Date.now() / 1000), // stable login-time marker (see happy-path comment)
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
      // Parsing is centralised in lib/auth/token-refresh-config.ts.
      const REFRESH_THRESHOLD_MS = getRefreshThresholdMs()
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
          // Refresh-token rotation race: two concurrent callers sharing a
          // deduped Promise both receive the rotated refresh_token, but the
          // *next* request may still carry the previous refreshToken in its
          // cookie before NextAuth's encode+set-cookie round-trip completes.
          // If the cookie arrives stale, Google's grace window (~30 s) usually
          // covers it; the 10 s AbortController timeout and fail-closed null
          // return in refreshGoogleToken() handle the invalid_grant case.
          // If sub-30 s grace becomes insufficient, consider storing the new
          // refreshToken server-side (e.g. Firestore/Redis) keyed on sub and
          // reading it in doRefresh() rather than from the cookie.
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
        tokenSub: String(token?.sub ?? 'unknown')
      })

      // Check if token exists and is valid
      if (!token || !token.sub) {
        log.warn("Session callback called with invalid token")
        return session; // Return empty session instead of null
      }

      // Send properties to the client.
      // token fields are string | undefined per next-auth.d.ts; cast to
      // `string | undefined` so downstream code that uses `|| fallback` works
      // correctly without accidentally treating `undefined` as a string.
      const givenName = token.given_name as string | undefined;
      const familyName = token.family_name as string | undefined;
      const fullName = token.name as string | undefined;
      const preferredUsername = token.preferred_username as string | undefined;
      const email = token.email as string | undefined;

      // Use given_name as display name, with multiple fallbacks
      const displayName = givenName || fullName || preferredUsername || familyName || email;

      // A missing email is theoretically unreachable: hasVerifiedGoogleEmail()
      // in signIn() rejects any token without a verified email before it can
      // produce a session.  But if something bypasses signIn() in a future path
      // (a test fixture, JIT provisioning, etc.), an empty-string email would
      // silently propagate into the users table — log a warn so the regression
      // surfaces in production telemetry immediately.
      if (!email) {
        log.warn("session callback reached with no email — signIn guard may have been bypassed", {
          sub: token.sub,
        })
      }

      session.user = {
        ...session.user,
        id: token.sub as string,
        // `email` is string | undefined per the cast fix; NextAuth's User type
        // requires string.  Use ?? '' as a safe fallback (see warn above).
        email: email ?? '',
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
      // `?? undefined` rather than `as string`: token fields are string | undefined
      // in next-auth.d.ts, so `as string` would silently assign undefined to a
      // string-typed slot when the token lacks the field.
      session.accessToken = token.accessToken ?? undefined;
      session.idToken = token.idToken ?? undefined;
      // Propagate loginIat (our stable login-time marker) as session.iat so the
      // polling session cache can key on sub+loginIat and avoid returning a stale
      // role set when the user re-authenticates within the 5-min TTL window.
      // token.loginIat is a custom JWT claim that NextAuth never overwrites; the
      // standard token.iat is reset to Date.now() on every re-encode by jose's
      // .setIssuedAt() and would therefore produce a fresh cache key per request.
      if (typeof token.loginIat === 'number') {
        session.iat = token.loginIat;
      } else {
        // loginIat is set unconditionally on every initial sign-in (happy path
        // and malformed-id_token fallback). Reaching here on a non-initial token
        // normally means a JWT cookie was issued before this deploy added loginIat
        // (stale cookies trigger this for up to SESSION_MAX_AGE seconds post-deploy).
        // Logged at debug rather than warn to avoid noise during the rollout window.
        // A real regression (loginIat assignment removed) is caught by CI tests.
        log.debug("loginIat missing on non-initial token — cache key will fall back to sub:0 until JWT re-issues", {
          sub: token.sub,
        })
        // Use `delete` rather than assigning `undefined` to avoid a runtime
        // type mismatch: the property is optional (number | undefined) in the
        // session type, but assigning undefined explicitly can confuse some
        // TypeScript narrowing and serialization paths.
        delete session.iat;
      }
      // Propagate roleVersion so /api/auth/refresh-session can compare against the
      // DB value and detect role changes.  Without this the sessionRoleVersion is
      // always undefined (→ 0), which causes needsRefresh=true on every poll as
      // soon as dbRoleVersion reaches 1 after the first role change.
      session.roleVersion = typeof token.roleVersion === 'number' ? token.roleVersion : undefined;

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
      // Allows relative callback URLs that start with '/' but NOT '//' or '/\':
      //   '//evil.com'  — protocol-relative URL; some runtimes resolve it as
      //                   https://evil.com when concatenated with baseUrl.
      //   '/\evil.com'  — some browsers normalize '\' → '/' during URL parsing,
      //                   turning this into '//evil.com'.
      // Both are cheap defense-in-depth for the redirect callback.
      if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\"))
        return `${baseUrl}${url}`
      // Allows callback URLs on the same origin. Both sides are normalised to
      // .origin so a trailing-slash AUTH_URL (e.g. "https://app.example.com/")
      // still matches correctly. Wrapped in try/catch because new URL() throws
      // on truly malformed strings (e.g. "not-a-url", ":::bad"). Schemes like
      // javascript: and data: do NOT throw — they produce origin "null", which
      // fails the equality check below and falls through to the safe default.
      try {
        if (new URL(url).origin === new URL(baseUrl).origin) return url
      } catch {
        // Malformed URL — fall through to safe default below.
      }
      return baseUrl + "/dashboard"
    },
    async signIn({ account, profile }) {
      const log = createLogger({ context: "auth-signin-callback" })

      if (account?.provider === 'google') {
        // Reject Google accounts with unverified emails.
        // hasVerifiedGoogleEmail uses `=== true` so absent/stringified/"false"
        // claims all fail — defense-in-depth against resolveUserId's email-fallback
        // path potentially fusing an unverified account into an existing user record.
        if (!hasVerifiedGoogleEmail(profile)) {
          // Mask the local-part before logging — email is PII even in warn logs.
          // Capture only the first character so short local-parts (≤3 chars) are
          // also masked (e.g. "abc@x.com" → "a***@x.com" not "abc***@x.com").
          // Fail-closed: emails without '@' do not match the regex; the fallback
          // '***' prevents a raw malformed address from appearing in logs.
          const maskedEmail = profile?.email
            ? (profile.email.includes('@')
                ? profile.email.replace(/^(.).*(@.*)$/, '$1***$2')
                : '***')
            : undefined
          log.warn("Sign-in rejected: Google email not verified", {
            email: maskedEmail,
            emailVerified: profile?.email_verified,
          })
          return false;
        }
        return true;
      }

      // Default-deny: any provider not explicitly listed above is rejected.
      // This is the safe posture — a future GitHub/SAML/etc. provider added
      // without thinking about email-verification would silently bypass *any*
      // check in the provider-conditional design; here it is rejected until an
      // explicit `if (account?.provider === 'new-provider')` branch is added.
      log.warn("Sign-in rejected: unsupported provider", {
        provider: account?.provider ?? 'unknown',
      })
      return false;
    },
  },
  pages: {
    error: "/auth/error",
  },
  session: {
    strategy: "jwt",
    // Session max age in seconds (default: 24 hours).
    // Parsing is centralised in lib/auth/token-refresh-config.ts (getSessionMaxAgeSecs).
    maxAge: getSessionMaxAgeSecs(),
  },
  // `cookies` block intentionally omitted — NextAuth v5 defaults are used as-is.
  // In production NextAuth automatically uses the `__Secure-` cookie-name prefix
  // (RFC 6265bis §4.1.3.1), which instructs browsers to reject same-name cookies
  // set from a non-HTTPS origin, closing the sibling-subdomain-XSS cookie-
  // overwrite vector. A custom `cookies` block would need to replicate this
  // prefix logic manually; removing it gets the protection for free.
  // debug: false suppresses NextAuth's CHUNKING_SESSION_COOKIE warnings (#361).
  // To enable verbose NextAuth debug output during local development without
  // touching this file, set AUTH_DEBUG=true in .env.local:
  //   debug: process.env.NODE_ENV === 'development' && process.env.AUTH_DEBUG === 'true',
  // Keeping it unconditionally false in source prevents accidental production enablement.
  debug: false,
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