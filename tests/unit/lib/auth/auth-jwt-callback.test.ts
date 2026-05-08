/**
 * Unit tests for auth.ts callbacks — security-critical paths
 *
 * Tests jwt(), signIn(), and redirect() callbacks extracted from authConfig in
 * isolation. All external dependencies (next-auth, Google provider, edge-logger,
 * token refresh) are mocked so the module loads without env vars or a live server.
 *
 * Covered paths:
 * - jwt() trigger=update → null (fail-closed; forces re-auth on role change)
 * - jwt() initial sign-in: happy decode, malformed id_token fallback,
 *   missing expires_at → 1-hour default
 * - jwt() proactive refresh: expiresAt < REFRESH_THRESHOLD_MS → refresh called;
 *   expiresAt > threshold → not called
 * - jwt() TOKEN_REFRESH_THRESHOLD_MS env override: custom value respected when
 *   >= 60 000 ms; values below the 60 s floor fall back to the 5-min default
 * - signIn() integration: returns false when hasVerifiedGoogleEmail fails
 * - redirect() hardening: malformed URL and javascript: scheme fall through to safe /dashboard default
 */

import type { NextAuthConfig } from "next-auth"
import type { JWT } from "next-auth/jwt"

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a base64url id_token payload segment. */
function makeIdToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `header.${payload}.signature`
}

/** Minimal valid existing-session token (not a fresh sign-in). */
function makeExistingToken(overrides: Partial<JWT> = {}): JWT {
  return {
    sub: "user-123",
    email: "user@example.com",
    provider: "google",
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour — no refresh needed
    refreshToken: "rt-abc",
    ...overrides,
  }
}

/** Minimal NextAuth account object for an initial sign-in. */
function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    provider: "google",
    providerAccountId: "google-prov-id",
    type: "oidc",
    id_token: makeIdToken({
      sub: "google-sub-456",
      email: "newuser@example.com",
      name: "New User",
      given_name: "New",
      family_name: "User",
      iat: Math.floor(Date.now() / 1000),
    }),
    access_token: "at-new",
    refresh_token: "rt-new",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }
}

// ── Load authConfig with fresh mocks ─────────────────────────────────────────
// The global jest.setup.js mocks out `@/auth` entirely (without authConfig).
// We remove that global mock factory, reset the module registry, then register
// mocks for auth.ts's dependencies before requiring the real module.

let callbacks: NonNullable<NextAuthConfig["callbacks"]>
let mockRefreshGoogleToken: jest.Mock

beforeAll(() => {
  jest.unmock("@/auth")
  jest.resetModules()

  mockRefreshGoogleToken = jest.fn().mockResolvedValue(null)

  jest.doMock("next-auth", () => {
    const fn = jest.fn(() => ({
      handlers: { GET: jest.fn(), POST: jest.fn() },
      auth: jest.fn(),
      signIn: jest.fn(),
      signOut: jest.fn(),
    }))
    return { __esModule: true, default: fn }
  })
  jest.doMock("next-auth/providers/google", () => ({
    __esModule: true,
    default: jest.fn(() => ({ id: "google", name: "Google", type: "oidc" })),
  }))
  jest.doMock("@/lib/auth/edge-logger", () => ({
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  }))
  jest.doMock("@/lib/auth/refresh-google-token", () => ({
    refreshGoogleToken: mockRefreshGoogleToken,
  }))
  jest.doMock("@/lib/auth/google-email-guard", () => ({
    // Default: email IS verified; individual tests override as needed.
    hasVerifiedGoogleEmail: jest.fn().mockReturnValue(true),
  }))

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authConfig } = require("@/auth") as { authConfig: NextAuthConfig }
  if (!authConfig?.callbacks) {
    throw new Error("authConfig.callbacks not found — global @/auth mock may still be active")
  }
  callbacks = authConfig.callbacks
})

afterAll(() => {
  jest.resetModules()
})

beforeEach(() => {
  mockRefreshGoogleToken.mockReset()
  mockRefreshGoogleToken.mockResolvedValue(null)
})

// ── jwt() — trigger=update fail-closed ───────────────────────────────────────

describe("jwt() callback — trigger=update fail-closed", () => {
  it("returns null regardless of token content", async () => {
    const result = await callbacks.jwt!({
      token: makeExistingToken(),
      trigger: "update",
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })
    expect(result).toBeNull()
  })

  it("returns null even for a fresh, non-expired token on 'update'", async () => {
    const result = await callbacks.jwt!({
      token: makeExistingToken({ expiresAt: Date.now() + 24 * 60 * 60 * 1000 }),
      trigger: "update",
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })
    expect(result).toBeNull()
  })

  it("does not call refreshGoogleToken on 'update'", async () => {
    await callbacks.jwt!({
      token: makeExistingToken(),
      trigger: "update",
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })
    expect(mockRefreshGoogleToken).not.toHaveBeenCalled()
  })
})

// ── jwt() — initial sign-in path ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccount = any

describe("jwt() callback — initial sign-in", () => {
  it("happy path: decodes id_token and returns correct fields", async () => {
    const account: AnyAccount = makeAccount()
    const result = (await callbacks.jwt!({
      token: {} as JWT,
      account,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })) as JWT

    expect(result).not.toBeNull()
    expect(result.sub).toBe("google-sub-456")
    expect(result.email).toBe("newuser@example.com")
    expect(result.given_name).toBe("New")
    expect(result.refreshToken).toBe("rt-new")
    expect(result.provider).toBe("google")
  })

  it("falls back to providerAccountId as sub when id_token payload is malformed", async () => {
    const account: AnyAccount = makeAccount({
      // `!!!notbase64` is not valid base64url, so Buffer.from(..., 'base64url')
      // produces a byte sequence that is not valid UTF-8 JSON — JSON.parse throws,
      // auth.ts catches it, and the fallback path uses providerAccountId as sub.
      id_token: "header.!!!notbase64.signature",
    })
    const result = (await callbacks.jwt!({
      token: {} as JWT,
      account,
      user: { id: "prov-user", email: "fallback@example.com", emailVerified: null },
      session: undefined,
    })) as JWT

    expect(result).not.toBeNull()
    // Fallback path uses providerAccountId, not decoded.sub
    expect(result.sub).toBe("google-prov-id")
    expect(result.provider).toBe("google")
  })

  it("uses 1-hour expiresAt when account.expires_at is absent", async () => {
    const before = Date.now()
    const account: AnyAccount = makeAccount({ expires_at: undefined })
    const result = (await callbacks.jwt!({
      token: {} as JWT,
      account,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })) as JWT

    // expiresAt should be ~1 hour from now (the default when expires_at is missing)
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 5000) // 5s slack
  })
})

// ── jwt() — proactive refresh ─────────────────────────────────────────────────

describe("jwt() callback — proactive refresh threshold", () => {
  const FIVE_MINUTES_MS = 5 * 60 * 1000

  it("calls refreshGoogleToken when expiresAt is less than 5 min away", async () => {
    // Token expires in 4 minutes — inside the default 5-minute threshold.
    const token = makeExistingToken({ expiresAt: Date.now() + 4 * 60 * 1000 })
    mockRefreshGoogleToken.mockResolvedValue({ ...token, expiresAt: Date.now() + 3600 * 1000 })

    await callbacks.jwt!({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    expect(mockRefreshGoogleToken).toHaveBeenCalledTimes(1)
    expect(mockRefreshGoogleToken).toHaveBeenCalledWith(token)
  })

  it("does NOT call refreshGoogleToken when expiresAt is more than 5 min away", async () => {
    // Token expires in 6 minutes — outside the default 5-minute threshold.
    const token = makeExistingToken({ expiresAt: Date.now() + 6 * 60 * 1000 })

    const result = await callbacks.jwt!({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    expect(mockRefreshGoogleToken).not.toHaveBeenCalled()
    // Token passes through unchanged
    expect((result as JWT).sub).toBe("user-123")
  })

  it("calls refreshGoogleToken when token is already expired", async () => {
    const token = makeExistingToken({ expiresAt: Date.now() - 60 * 1000 }) // 1 min ago
    mockRefreshGoogleToken.mockResolvedValue({ ...token, expiresAt: Date.now() + 3600 * 1000 })

    await callbacks.jwt!({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    expect(mockRefreshGoogleToken).toHaveBeenCalledTimes(1)
  })

  it("returns null when refresh token is absent and token is expiring", async () => {
    // No refreshToken → cannot refresh → force re-authentication.
    const token = makeExistingToken({
      expiresAt: Date.now() + FIVE_MINUTES_MS - 1000, // just inside threshold
      refreshToken: undefined,
    })

    const result = await callbacks.jwt!({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    expect(result).toBeNull()
    expect(mockRefreshGoogleToken).not.toHaveBeenCalled()
  })
})

// ── signIn() callback integration ─────────────────────────────────────────────

describe("signIn() callback — email-verification gate", () => {
  it("returns false when hasVerifiedGoogleEmail returns false", async () => {
    // Override the mock for this test only.
    const { hasVerifiedGoogleEmail } = jest.requireMock(
      "@/lib/auth/google-email-guard"
    ) as { hasVerifiedGoogleEmail: jest.Mock }
    hasVerifiedGoogleEmail.mockReturnValueOnce(false)

    const result = await callbacks.signIn!({
      account: { provider: "google" } as AnyAccount,
      profile: { email: "unverified@example.com", email_verified: false, sub: "x" },
      user: { id: "", email: "", emailVerified: null },
      credentials: undefined,
    })

    expect(result).toBe(false)
  })

  it("returns true when hasVerifiedGoogleEmail returns true", async () => {
    const { hasVerifiedGoogleEmail } = jest.requireMock(
      "@/lib/auth/google-email-guard"
    ) as { hasVerifiedGoogleEmail: jest.Mock }
    hasVerifiedGoogleEmail.mockReturnValueOnce(true)

    const result = await callbacks.signIn!({
      account: { provider: "google" } as AnyAccount,
      profile: { email: "verified@example.com", email_verified: true, sub: "y" },
      user: { id: "", email: "", emailVerified: null },
      credentials: undefined,
    })

    expect(result).toBe(true)
  })

  it("rejects non-google providers (default-deny: only 'google' is explicitly allowed)", async () => {
    const { hasVerifiedGoogleEmail } = jest.requireMock(
      "@/lib/auth/google-email-guard"
    ) as { hasVerifiedGoogleEmail: jest.Mock }
    hasVerifiedGoogleEmail.mockReturnValueOnce(false) // irrelevant — never reached for non-google

    const result = await callbacks.signIn!({
      account: { provider: "github" } as AnyAccount,
      profile: { email: "github@example.com", email_verified: false, sub: "z" },
      user: { id: "", email: "", emailVerified: null },
      credentials: undefined,
    })

    // Default-deny: providers not explicitly handled return false.
    // Only 'google' has an explicit allow-branch; any future provider must be
    // added consciously with its own email-verification logic.
    expect(result).toBe(false)
  })
})

// ── session() callback ────────────────────────────────────────────────────────

/** Minimal NextAuth Session shape expected by the session callback. */
function makeSession() {
  return {
    user: { id: "", email: "", name: "", givenName: null as string | null, familyName: null as string | null },
    // accessToken intentionally omitted: removed from Session type (JWT-only now)
    idToken: "",
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
  }
}

describe("session() callback", () => {
  it("returns the populated session when token is valid", async () => {
    const token: JWT = {
      sub: "google-sub-789",
      email: "user@example.com",
      given_name: "Alice",
      family_name: "Smith",
      name: "Alice Smith",
      accessToken: "at-xyz",
      idToken: "it-xyz",
      expiresAt: Date.now() + 3600 * 1000,
      provider: "google",
    }

    const result = (await callbacks.session!({
      session: makeSession() as AnyAccount,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount

    expect(result.user.id).toBe("google-sub-789")
    expect(result.user.email).toBe("user@example.com")
    expect(result.user.name).toBe("Alice") // givenName takes precedence
    // accessToken is intentionally NOT propagated to session (JWT-only) — no assertion
    expect(result.idToken).toBe("it-xyz")
  })

  it("falls back through name chain: fullName when givenName absent", async () => {
    const token: JWT = {
      sub: "s",
      email: "u@example.com",
      name: "Full Name",
      // given_name intentionally absent
      expiresAt: Date.now() + 3600 * 1000,
      provider: "google",
    }
    const result = (await callbacks.session!({
      session: makeSession() as AnyAccount,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount
    expect(result.user.name).toBe("Full Name")
  })

  it("falls back to email when all name fields are absent", async () => {
    const token: JWT = {
      sub: "s",
      email: "fallback@example.com",
      // given_name, name, preferred_username, family_name all absent
      expiresAt: Date.now() + 3600 * 1000,
      provider: "google",
    }
    const result = (await callbacks.session!({
      session: makeSession() as AnyAccount,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount
    expect(result.user.name).toBe("fallback@example.com")
  })

  it("builds a normal session even when token.expiresAt is in the past", async () => {
    // The expired-token sentinel branch was removed (CLAUDE.md: don't add
    // unreachable error handling). jwt() is solely responsible for intercepting
    // expired tokens — it returns null, which causes NextAuth to clear the
    // session cookie before session() ever runs.  If session() somehow receives
    // a token with a past expiresAt, it falls through to the normal build path
    // rather than synthesising an empty sentinel (which was a footgun: any
    // `if (session?.user)` check would have happily proceeded with id="").
    const token: JWT = {
      sub: "s",
      email: "user@example.com",
      expiresAt: Date.now() - 60 * 1000, // 1 minute ago
      provider: "google",
    }
    const result = (await callbacks.session!({
      session: makeSession() as AnyAccount,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount
    // session() builds normally — the sub is propagated as the user id.
    // The token having a past expiresAt is irrelevant here; jwt() already
    // ran and did not return null (simulated by the test passing the token
    // directly), so session() just maps the claims as usual.
    expect(result.user.id).toBe("s")
    expect(result.user.email).toBe("user@example.com")
  })

  // Regression pin for the loginIat propagation chain:
  //   decoded.iat → token.loginIat (jwt callback, initial sign-in)
  //   → session.loginIat (session callback)
  //   → UserSession.loginIat (getServerSession projection)
  //   → generateSessionCacheKey (polling cache key)
  // Each link is unit-tested at its own layer; this test pins the
  // session-callback step (token.loginIat → session.loginIat) so a future
  // change to the session callback cannot silently break the chain.
  it("propagates token.loginIat to session.loginIat", async () => {
    const loginIat = 1_700_000_000 // stable login-time marker
    const token: JWT = {
      sub: "google-sub-iat",
      email: "iat@example.com",
      loginIat,
      expiresAt: Date.now() + 3600 * 1000,
      provider: "google",
    }
    const result = (await callbacks.session!({
      session: makeSession() as AnyAccount,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount
    expect(result.loginIat).toBe(loginIat)
  })

  it("does not set session.loginIat when token.loginIat is absent (stale pre-deploy cookie)", async () => {
    // Stale JWTs issued before loginIat was added should skip the cache
    // (generateSessionCacheKey returns null), not collide under session:sub:0.
    const token: JWT = {
      sub: "google-sub-no-iat",
      email: "noiat@example.com",
      // loginIat intentionally absent
      expiresAt: Date.now() + 3600 * 1000,
      provider: "google",
    }
    const result = (await callbacks.session!({
      session: makeSession() as AnyAccount,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount
    // session.loginIat should be absent (not 0, not undefined via assignment —
    // auth.ts uses `delete session.loginIat` for type-safety reasons).
    expect(result.loginIat).toBeUndefined()
  })

  // Regression pin: missing email must NOT throw — graceful return instead.
  //
  // A JWT issued before the hasVerifiedGoogleEmail guard was deployed could
  // reach the session callback on a repeat visit within the session TTL, with
  // no email claim.  Previously this caused a throw (→ 500 in the browser).
  // The correct behaviour is to return the session without session.user.id set:
  // getServerSession() checks `if (!session?.user?.id) return null`, so
  // middleware treats the response as unauthenticated and redirects to sign-in.
  it("returns session without user.id when token.email is absent (stale pre-guard JWT)", async () => {
    const token: JWT = {
      sub: "google-sub-no-email",
      // email intentionally absent — simulates a stale JWT issued before the
      // hasVerifiedGoogleEmail signIn() guard was deployed.
      expiresAt: Date.now() + 3600 * 1000,
      provider: "google",
    }
    const baseSession = makeSession() as AnyAccount

    const result = (await callbacks.session!({
      session: baseSession,
      token,
      user: { id: "", email: "", emailVerified: null },
      newSession: undefined,
      trigger: "update",
    })) as AnyAccount

    // Must not throw. Must return a session whose user.id is falsy so
    // getServerSession()'s `if (!session?.user?.id)` check treats it as
    // unauthenticated and returns null — causing middleware to redirect.
    // makeSession() initialises id: "" (not undefined); the session callback
    // returns the base session unchanged (no user.id assignment) when email is
    // absent, so id stays "" — falsy, and functionally identical to undefined
    // from getServerSession()'s perspective.
    expect(result.user?.id).toBeFalsy()
  })
})

// ── jwt() — TOKEN_REFRESH_THRESHOLD_MS env override ──────────────────────────

describe("jwt() callback — TOKEN_REFRESH_THRESHOLD_MS env override", () => {
  const originalThreshold = process.env.TOKEN_REFRESH_THRESHOLD_MS

  afterEach(() => {
    // Restore original value (or delete if it was never set)
    if (originalThreshold === undefined) {
      delete process.env.TOKEN_REFRESH_THRESHOLD_MS
    } else {
      process.env.TOKEN_REFRESH_THRESHOLD_MS = originalThreshold
    }
  })

  it("respects TOKEN_REFRESH_THRESHOLD_MS when >= 60 000 ms (2-min override)", async () => {
    process.env.TOKEN_REFRESH_THRESHOLD_MS = "120000" // 2 minutes
    // Token expires in 90 seconds — inside the 2-min custom threshold.
    const token = makeExistingToken({ expiresAt: Date.now() + 90 * 1000 })
    mockRefreshGoogleToken.mockResolvedValue({ ...token, expiresAt: Date.now() + 3600 * 1000 })

    await callbacks.jwt!({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    expect(mockRefreshGoogleToken).toHaveBeenCalledTimes(1)
  })

  it("enforces 60 s floor: values < 60 000 ms fall back to the 5-min default", async () => {
    process.env.TOKEN_REFRESH_THRESHOLD_MS = "30000" // 30 s — below the 60 s floor
    // With the floor enforced, effective threshold remains 5 minutes.
    // Token expires in 4 minutes — inside the 5-min default, so refresh fires.
    const token = makeExistingToken({ expiresAt: Date.now() + 4 * 60 * 1000 })
    mockRefreshGoogleToken.mockResolvedValue({ ...token, expiresAt: Date.now() + 3600 * 1000 })

    await callbacks.jwt!({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    // 30 s is below the 60 s floor → falls back to 5 min → 4-min token triggers refresh
    expect(mockRefreshGoogleToken).toHaveBeenCalledTimes(1)
  })
})

// ── redirect() callback — malformed URL hardening ────────────────────────────

describe("redirect() callback — URL handling", () => {
  const baseUrl = "https://app.example.com"

  it("allows relative callback URLs", async () => {
    const result = await callbacks.redirect!({ url: "/dashboard", baseUrl })
    expect(result).toBe(`${baseUrl}/dashboard`)
  })

  it("allows same-origin callback URLs", async () => {
    const result = await callbacks.redirect!({ url: `${baseUrl}/chat`, baseUrl })
    expect(result).toBe(`${baseUrl}/chat`)
  })

  it("rejects cross-origin URLs and returns safe default", async () => {
    const result = await callbacks.redirect!({ url: "https://evil.example.com/steal", baseUrl })
    expect(result).toBe(`${baseUrl}/dashboard`)
  })

  it("handles malformed URL strings without throwing", async () => {
    // A completely malformed string causes new URL() to throw — caught, falls through.
    const result = await callbacks.redirect!({ url: "not-a-url", baseUrl })
    expect(result).toBe(`${baseUrl}/dashboard`)
  })

  it("rejects javascript: scheme (origin is 'null') and returns safe default", async () => {
    // new URL("javascript:alert(1)") does NOT throw in Node — it parses successfully
    // but produces origin = "null", which never matches the baseUrl origin.
    // This test locks in the hardening so XSS-via-redirect is not regressable.
    const result = await callbacks.redirect!({ url: "javascript:alert(1)", baseUrl })
    expect(result).toBe(`${baseUrl}/dashboard`)
  })

  it("matches correctly when baseUrl has a trailing slash", async () => {
    // Both sides normalised to .origin so trailing-slash AUTH_URL still matches.
    const baseUrlWithSlash = "https://app.example.com/"
    const result = await callbacks.redirect!({
      url: "https://app.example.com/chat",
      baseUrl: baseUrlWithSlash,
    })
    expect(result).toBe("https://app.example.com/chat")
  })

  it("rejects // prefix (protocol-relative open-redirect vector)", async () => {
    // '//evil.com' looks like a relative path but some runtimes resolve it as
    // https://evil.com when prepended with the base URL.
    const result = await callbacks.redirect!({ url: "//evil.com", baseUrl })
    expect(result).not.toMatch(/evil\.com/)
    expect(result).toBe(`${baseUrl}/dashboard`)
  })

  it("rejects /\\ prefix (backslash normalisation open-redirect vector)", async () => {
    // Browsers normalize '\' → '/' so '/\\evil.com' becomes '//evil.com'.
    // The guard checks for both prefixes explicitly.
    const result = await callbacks.redirect!({ url: "/\\evil.com", baseUrl })
    expect(result).not.toMatch(/evil\.com/)
    expect(result).toBe(`${baseUrl}/dashboard`)
  })
})
