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
 * - signIn() integration: returns false when hasVerifiedGoogleEmail fails
 * - redirect() hardening: malformed URL falls through to safe /dashboard default
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
      // Replace valid id_token with one whose payload segment is not valid JSON.
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

  it("returns true for non-google providers (gate is provider-scoped)", async () => {
    const { hasVerifiedGoogleEmail } = jest.requireMock(
      "@/lib/auth/google-email-guard"
    ) as { hasVerifiedGoogleEmail: jest.Mock }
    hasVerifiedGoogleEmail.mockReturnValueOnce(false) // would reject if applied

    const result = await callbacks.signIn!({
      account: { provider: "github" } as AnyAccount,
      profile: { email: "github@example.com", email_verified: false, sub: "z" },
      user: { id: "", email: "", emailVerified: null },
      credentials: undefined,
    })

    // Guard only fires for provider === 'google'
    expect(result).toBe(true)
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
    // new URL("javascript:alert(1)") parses in Node but origin is "null" — falls
    // through to /dashboard. A completely malformed string throws — also falls through.
    const result = await callbacks.redirect!({ url: "not-a-url", baseUrl })
    expect(result).toBe(`${baseUrl}/dashboard`)
  })
})
