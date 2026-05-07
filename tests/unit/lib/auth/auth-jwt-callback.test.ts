/**
 * Unit tests for auth.ts JWT callback — security-critical paths
 *
 * Tests the jwt() callback extracted from authConfig in isolation. All
 * external dependencies (next-auth, Google provider, edge-logger, token
 * refresh) are mocked so the module loads without env vars or a live server.
 *
 * Covered paths:
 * - `trigger === "update"` → returns null (fail-closed; forces re-auth)
 *   Regression guard: if this path ever starts returning the token instead of
 *   null, a call to `useSession().update()` would silently serve a stale
 *   high-privilege JWT rather than forcing re-authentication on role demotions.
 * - Valid non-expiring existing session → token passes through unchanged.
 */

import type { NextAuthConfig } from "next-auth"
import type { JWT } from "next-auth/jwt"

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

// ── Load authConfig with fresh mocks ─────────────────────────────────────────
// The global jest.setup.js mocks out `@/auth` entirely (without authConfig).
// We remove that global mock factory for this file, reset the module registry,
// then register mocks for auth.ts's dependencies before requiring it fresh.

let jwtCallback: NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>

beforeAll(() => {
  // Remove the global `@/auth` factory mock so we load the real module below.
  jest.unmock("@/auth")
  // Clear all cached module instances.
  jest.resetModules()

  // Register dependency mocks. These apply to all subsequent require() calls
  // within this beforeAll (and to the module graph they pull in).
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
    refreshGoogleToken: jest.fn().mockResolvedValue(null),
  }))
  jest.doMock("@/lib/auth/google-email-guard", () => ({
    hasVerifiedGoogleEmail: jest.fn().mockReturnValue(true),
  }))

  // Load the real auth module with the mocked dependencies.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@/auth") as { authConfig?: NextAuthConfig }
  if (!mod.authConfig?.callbacks?.jwt) {
    throw new Error(
      "authConfig.callbacks.jwt was not found in @/auth. " +
      "The global jest.setup.js mock may still be active — check that jest.unmock('@/auth') ran first."
    )
  }
  jwtCallback = mod.authConfig.callbacks.jwt
})

afterAll(() => {
  // Restore the module registry for subsequent test files.
  jest.resetModules()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("auth.ts jwt() callback — trigger=update fail-closed", () => {
  it("returns null when trigger is 'update', regardless of token content", async () => {
    const result = await jwtCallback({
      token: makeExistingToken(),
      trigger: "update",
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })
    // null forces NextAuth to invalidate the session → forces re-authentication.
    // This is the fail-closed policy for role-change propagation.
    expect(result).toBeNull()
  })

  it("returns null even when the token is fresh and non-expired on 'update'", async () => {
    // The policy is unconditional — token validity is irrelevant for 'update'.
    const result = await jwtCallback({
      token: makeExistingToken({ expiresAt: Date.now() + 24 * 60 * 60 * 1000 }),
      trigger: "update",
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })
    expect(result).toBeNull()
  })

  it("does not attempt a token refresh on 'update'", async () => {
    // Refreshing a token that is about to be invalidated would be wasteful —
    // confirm the callback short-circuits before any network I/O.
    const { refreshGoogleToken } =
      jest.requireMock("@/lib/auth/refresh-google-token") as {
        refreshGoogleToken: jest.Mock
      }
    refreshGoogleToken.mockClear()

    await jwtCallback({
      token: makeExistingToken(),
      trigger: "update",
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    expect(refreshGoogleToken).not.toHaveBeenCalled()
  })
})

describe("auth.ts jwt() callback — valid existing session", () => {
  it("returns the token unchanged when it is not near expiry", async () => {
    const token = makeExistingToken()
    const result = await jwtCallback({
      token,
      account: null,
      user: { id: "", email: "", emailVerified: null },
      session: undefined,
    })

    // Token is valid and far from expiry — passes through without modification.
    expect(result).not.toBeNull()
    expect((result as JWT).sub).toBe("user-123")
  })
})
