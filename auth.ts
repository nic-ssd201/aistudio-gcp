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
// Note: evaluated once at module load. Tests that mutate AUTH_GOOGLE_FORCE_CONSENT
// via process.env between cases must use jest.isolateModules() (or jest.resetModules())
// to reload auth.ts and pick up the new value — a simple assignment mid-test is
// not visible here since this const is already bound.
const googleForceConsent = process.env.AUTH_GOOGLE_FORCE_CONSENT?.trim().toLowerCase() !== 'false'

// Log the effective Google prompt mode at module load so operators can confirm
// what they actually got (consent vs select_account) without reading source code.
// Uses log.warn (not log.info) because edge-logger only emits INFO/DEBUG in
// development — warn is always emitted and this startup-config line is only
// useful in production where the choice of prompt mode actually matters.
//
// Gated by globalThis.__authConfigLogged__ so Next.js HMR reloads in development
// don't emit a fresh warn line on every file save.  In production there is no
// HMR; the flag is a no-op (the module loads exactly once per process).
declare global { var __authConfigLogged__: boolean | undefined }
if (!globalThis.__authConfigLogged__) {
  globalThis.__authConfigLogged__ = true
  const log = createLogger({ context: 'auth-config' })
  const effectivePrompt = googleForceConsent ? 'consent' : 'select_account'
  log.warn(`Google OAuth prompt mode: "${effectivePrompt}"`, {
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
    // Hosted-domain restriction (hd): required in production (env-validation.ts).
    // Set to a Google Workspace domain (e.g. "psd401.net") to restrict sign-in
    // at the IdP level — Google rejects non-domain accounts before the OAuth
    // code exchange.  Set to the sentinel "OPEN" to explicitly allow any Google
    // account (JIT-provisions all sign-ins via resolve-user.ts).
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      authorization: {
        params: {
          scope: "openid email profile",
          access_type: "offline",
          // Conditionally gate sign-in to a specific Google Workspace domain.
          // When AUTH_GOOGLE_HD is a real domain, Google rejects accounts outside
          // that domain before the OAuth code exchange — fail-closed at the IdP level.
          // The sentinel value "OPEN" (set by operators who explicitly allow any
          // Google account) is intentionally excluded so Google never sees "hd=OPEN".
          // env-validation.ts requires AUTH_GOOGLE_HD in production; a missing value
          // is a startup error rather than a silent open-access misconfiguration.
          ...(() => {
            const hd = process.env.AUTH_GOOGLE_HD?.trim();
            return (hd && hd !== 'OPEN') ? { hd } : {};
          })(),
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
        // warn (not info): every useSession().update() call logs out the user
        // immediately.  Today no code path calls update() — pinned by
        // tests/unit/lib/auth/no-use-session-update.test.ts — but if that ever
        // changes, this warn surfaces the breakage in production telemetry before
        // users file tickets.  Filter on context="auth-jwt-callback" +
        // message="Session update triggered" in Cloud Logging to alert.
        log.warn("Session update triggered — forcing re-authentication (fail-closed); " +
          "investigate — no code path should call useSession().update() in this app")
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
          // Validate JWT structure before indexing: a well-formed JWT has exactly
          // three dot-separated parts (header.payload.signature).  An id_token
          // that fails this check is structurally malformed — split('.')[1] would
          // return undefined and atob(undefined) would throw a cryptic TypeError
          // rather than a meaningful auth error.  Fail loudly here instead.
          const parts = account.id_token.split('.')
          if (parts.length !== 3) {
            throw new Error(
              `malformed id_token: expected 3 dot-separated JWT parts, got ${parts.length}`
            )
          }
          // base64url → base64: replace URL-safe chars, then restore padding.
          // JWT segments omit `=` padding; the WHATWG atob() spec requires the
          // input length to be a multiple of 4 — without padding, strict runtimes
          // throw InvalidCharacterError for payloads whose length is not 0 mod 4.
          // `(4 - len % 4) % 4` gives 0, 1, or 2 padding chars as needed (a JWT
          // payload is never 3-short because base64 encodes 3 bytes → 4 chars).
          const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const base64Payload = b64 + '='.repeat((4 - b64.length % 4) % 4);
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
          }

          // Refresh failed. If the token is still valid (proactive refresh,
          // not yet expired), return the existing token so the user is not
          // forced to re-authenticate due to a transient Google outage or
          // network blip. The next jwt() callback will retry.
          // If the token is genuinely expired, there is no valid token to fall
          // back to — force re-auth immediately.
          if (!isExpired) {
            log.warn("Proactive refresh failed but token still valid — returning existing token; next callback will retry", {
              expiresAt: new Date(expiresAt).toISOString(),
              minutesRemaining: Math.round((expiresAt - now) / (1000 * 60)),
            })
            return token
          }

          log.warn("Token refresh failed and token is expired — forcing re-authentication")
          return null
        } catch (error) {
          // Unexpected throw from refreshGoogleToken (e.g. programmer error).
          // Apply the same proactive-vs-expired distinction: don't force
          // re-auth if the token is still usable.
          if (!isExpired) {
            log.warn("Proactive refresh threw unexpectedly but token still valid — returning existing token", {
              error: error instanceof Error ? error.message : 'Unknown error',
              minutesRemaining: Math.round((expiresAt - now) / (1000 * 60)),
            })
            return token
          }
          log.error("Token refresh threw error and token is expired — forcing re-authentication", {
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
      // in signIn() rejects any token without a verified email before the
      // session callback is reached.  However, a JWT issued before that guard
      // was deployed could reach this callback on a repeat visit within the
      // session TTL.  Throwing here would surface as a 500 rather than a
      // controlled re-auth for those stale-cookie cases.
      //
      // Instead: return the session without setting session.user.id.  The next
      // layer (getServerSession → "if (!session?.user?.id) return null") treats
      // this as "not authenticated", and middleware redirects to sign-in — the
      // same observable result as a proper signOut, but without the 500 noise.
      // Log at error level so the bypass (if it ever happens) is visible in
      // Cloud Logging without disrupting the user's browser session.
      if (!email) {
        log.error(
          "session callback reached with no email — stale pre-guard JWT or signIn bypass; treating as unauthenticated",
          { sub: token.sub }
        )
        return session  // session.user.id absent → getServerSession() returns null → middleware redirects
      }

      session.user = {
        ...session.user,
        id: token.sub as string,
        email,
        name: displayName,
        givenName: givenName || null,
        familyName: familyName || null,
      }

      // Token propagation to session (server-side use only):
      // - refreshToken: JWT-only — never exposed here; only needed in jwt() callback.
      // - accessToken: JWT-only — no server or client code reads session.accessToken;
      //   keeping it off the session reduces the attack surface if a future bug
      //   accidentally serializes session fields to a client response.
      // - idToken: propagated because MCP connector-service.ts uses it as a Bearer
      //   token for cognito_passthrough (now session-passthrough) auth type.
      // `?? undefined` rather than `as string`: token fields are string | undefined
      // in next-auth.d.ts, so `as string` would silently assign undefined to a
      // string-typed slot when the token lacks the field.
      session.idToken = token.idToken ?? undefined;
      // Propagate loginIat (our stable login-time marker) as session.loginIat so
      // the polling session cache can key on sub+loginIat and avoid returning a
      // stale role set when the user re-authenticates within the 5-min TTL window.
      // token.loginIat is a custom JWT claim that NextAuth never overwrites; the
      // standard token.iat is reset to Date.now() on every re-encode by jose's
      // .setIssuedAt() and would therefore produce a fresh cache key per request.
      // Session.loginIat is distinct from NextAuth's own session.iat (standard JWT
      // claim) to avoid confusion and accidental collision.
      if (typeof token.loginIat === 'number') {
        session.loginIat = token.loginIat;
      } else {
        // loginIat is set unconditionally on every initial sign-in (happy path
        // and malformed-id_token fallback). Reaching here on a non-initial token
        // normally means a JWT cookie was issued before this deploy added loginIat
        // (stale cookies trigger this for up to SESSION_MAX_AGE seconds post-deploy).
        // Logged at debug rather than warn to avoid noise during the rollout window.
        // A real regression (loginIat assignment removed) is caught by CI tests.
        log.debug("loginIat missing on non-initial token — polling cache will be skipped until JWT re-issues", {
          sub: token.sub,
        })
        // Use `delete` rather than assigning `undefined` so the key is absent
        // from JSON.stringify output.  Both produce `number | undefined` at the
        // TypeScript level, but `JSON.stringify({loginIat: undefined})` → `{}` while
        // `delete obj.loginIat` guarantees the key is genuinely missing — keeps the
        // serialized session minimal and avoids a spurious `"loginIat":null` entry
        // if a serializer treats explicit-undefined as null.
        delete session.loginIat;
      }
      // Propagate roleVersion so /api/auth/refresh-session can compare against the
      // DB value and detect role changes.  Without this the sessionRoleVersion is
      // always undefined (→ 0), which causes needsRefresh=true on every poll as
      // soon as dbRoleVersion reaches 1 after the first role change.
      session.roleVersion = typeof token.roleVersion === 'number' ? token.roleVersion : undefined;

      log.debug("Session created successfully", {
        userId: session.user.id,
        userEmail: session.user.email,
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
      // Defense-in-depth: also resolve the relative path against baseUrl and
      // compare origins.  A URL-encoded backslash like '/%5Cevil.com' passes
      // the literal-string checks above but decodes to '/\evil.com' inside
      // WHATWG URL parsing — some parsers then treat it as '//evil.com' with a
      // different host.  Verifying the resolved origin catches this class of
      // encoding-based bypass.
      if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) {
        try {
          if (new URL(url, baseUrl).origin === new URL(baseUrl).origin)
            return `${baseUrl}${url}`
        } catch {
          // Malformed relative path — fall through to safe default below.
        }
      }
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
  // AUTH_DEBUG=true enables NextAuth verbose logging (session cookie chunking, token events).
  // Off by default; set in .env.local for local debugging without touching this file.
  // False in production suppresses CHUNKING_SESSION_COOKIE noise (#361).
  debug: process.env.AUTH_DEBUG === 'true',
}

/**
 * Belt-and-suspenders guard: throws if AUTH_GOOGLE_ID or AUTH_GOOGLE_SECRET
 * are absent.
 *
 * requireValidEnv() in instrumentation.ts catches missing credentials at
 * startup but deliberately does NOT re-throw — it only logs, so Cloud Run
 * health checks can still respond during a rolling deploy with a
 * misconfigured revision.  As a result the Google provider above would
 * silently receive `undefined` cast to string, and the first sign-in attempt
 * would produce a cryptic "invalid_client" from Google rather than a clear
 * message pointing to the missing vars.
 *
 * Called by createAuth() (OAuth code-exchange path) to surface the real cause
 * before NextAuth ever uses the config.  NOT called from the middlewareAuth
 * construction below — see the comment there for the rationale.
 */
function assertGoogleCreds(): void {
  if (!process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET) {
    throw new Error(
      'Missing Google OAuth credentials: AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set. ' +
      'See ENVIRONMENT_VARIABLES.md for setup instructions.'
    );
  }
}

// Factory function — returns a NextAuth instance bound to authConfig.
// NextAuth route modules (app/api/auth/[...nextauth]/route.ts) are module-level
// singletons in Next.js, so createAuth() is called once at module load, not
// per-request. The function exists to keep authConfig private and allow tests
// to call createAuth() with a fresh NextAuth instance per test file via jest.resetModules().
export function createAuth() {
  assertGoogleCreds()
  return NextAuth(authConfig)
}

// Middleware auth — constructed at module load for Next.js middleware compatibility.
//
// The credential guard in createAuth() (above) is NOT duplicated here.  This is
// intentional: authMiddleware is used exclusively for JWT verification in
// Next.js middleware (lib/middleware.ts), which only decodes the signed session
// cookie — it never initiates an OAuth code exchange that would use clientId or
// clientSecret.  NextAuth does not validate provider credentials at construction
// time; they are only exercised during the /api/auth/callback/google flow, which
// goes through createAuth(), where the guard does fire.
//
// Known gap: if AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are absent, the module-level
// Google({ clientId: undefined as string }) call is silent rather than loud.
// requireValidEnv() in instrumentation.ts already logs an error for missing creds
// at startup; that log line is the authoritative startup signal.  A future
// refactor that makes authMiddleware lazy (computed on first call) would close
// this gap cleanly — tracked in follow-up alongside the credential-guard audit.
const middlewareAuth = NextAuth(authConfig)
export const { auth: authMiddleware } = middlewareAuth

// Export auth handlers for route.ts files
// These need to be created per-request in the route handlers
export function createAuthHandlers() {
  const { handlers } = createAuth()
  return handlers
}