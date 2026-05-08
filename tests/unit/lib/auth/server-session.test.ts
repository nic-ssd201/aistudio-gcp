// @ts-nocheck — jest.doMock() factory types inside jest.isolateModules() are not
// inferrable by TypeScript; @ts-nocheck must be the first line of the file.
/**
 * Regression pin: getServerSession() must propagate session.iat → UserSession.iat
 * so the polling cache can key on sub+iat and avoid returning stale role sets
 * when a user re-authenticates within the 5-min TTL window.
 *
 * Previously session.iat was never propagated (auth.ts read token.iat which NextAuth
 * overwrites on every re-encode; later fixed to token.loginIat). A refactor that
 * silently dropped session.iat → UserSession.iat would re-break the cache without
 * any type error or runtime exception — only polling cache misses on every request.
 *
 * Uses jest.isolateModules() + jest.requireActual() to load the real getServerSession()
 * implementation. jest.requireActual bypasses the global jest.setup.js stub for
 * @/lib/auth/server-session while still resolving the module's own imports from
 * the isolated registry where our jest.doMock() calls are active.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals"

const STUB_IAT = 1_700_000_000 // stable login-time timestamp
const STUB_SUB = "google-sub-abc"
const STUB_ROLE_VERSION = 3 // non-zero so the "absent → 0" comparison is testable

function makeNextAuthSession(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: STUB_SUB,
      email: "user@example.com",
      givenName: "Alice",
      familyName: "Smith",
    },
    idToken: "id-token-value",
    iat: STUB_IAT,
    roleVersion: STUB_ROLE_VERSION,
    ...overrides,
  }
}

type GetServerSessionFn = () => Promise<{ sub: string; email?: string; idToken?: string; iat?: number; roleVersion?: number } | null>

/**
 * Load the real getServerSession() with a controlled auth() mock,
 * escaping the global jest.setup.js stub.
 */
async function loadGetServerSession(sessionOverrides: Record<string, unknown> = {}): Promise<GetServerSessionFn> {
  let fn!: GetServerSessionFn

  jest.isolateModules(() => {
    jest.doMock("@/auth", () => ({
      createAuth: jest.fn(() => ({
        auth: jest.fn().mockResolvedValue(makeNextAuthSession(sessionOverrides)),
      })),
    }))

    jest.doMock("@/lib/auth/request-context", () => ({
      createRequestContext: jest.fn().mockResolvedValue({ requestId: "test-req" }),
    }))

    jest.doMock("@/lib/logger", () => ({
      default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
      createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
    }))

    // jest.requireActual bypasses the global @/lib/auth/server-session mock from
    // jest.setup.js while still resolving the module's own imports (@/auth, logger,
    // request-context) from the isolated registry where our doMock calls are active.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fn = jest.requireActual("@/lib/auth/server-session").getServerSession as GetServerSessionFn
  })

  return fn
}

describe("getServerSession() — session field propagation to UserSession", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("propagates session.iat to UserSession.iat", async () => {
    const getServerSession = await loadGetServerSession()

    const result = await getServerSession()

    expect(result).not.toBeNull()
    // iat must reach UserSession so the polling cache key is sub+iat (not sub+undefined)
    expect(result!.iat).toBe(STUB_IAT)
  })

  it("sets UserSession.iat to undefined when session.iat is absent", async () => {
    const getServerSession = await loadGetServerSession({ iat: undefined })

    const result = await getServerSession()

    expect(result).not.toBeNull()
    // undefined iat → cache key falls back to sub+0 (a miss, but not an error)
    expect(result!.iat).toBeUndefined()
  })

  it("propagates sub, email, and idToken alongside iat", async () => {
    const getServerSession = await loadGetServerSession()

    const result = await getServerSession()

    expect(result!.sub).toBe(STUB_SUB)
    expect(result!.email).toBe("user@example.com")
    expect(result!.idToken).toBe("id-token-value")
    expect(result!.iat).toBe(STUB_IAT)
  })

  it("returns null when session has no user.id (unauthenticated)", async () => {
    const getServerSession = await loadGetServerSession({
      user: { id: "", email: "x@y.com" },
    })

    const result = await getServerSession()

    expect(result).toBeNull()
  })

  // ── roleVersion propagation regression pin ────────────────────────────────
  //
  // Bug: server-session.ts spread session.user but never explicitly projected
  // session.roleVersion onto the returned UserSession.  refresh-session/route.ts
  // read (session as {roleVersion?:number}).roleVersion which was always undefined
  // → 0, so needsRefresh=true fired on every poll the moment dbRoleVersion
  // reached 1 after the first role change, causing constant re-auth churn for
  // every active user.  These tests lock in the correct propagation.

  it("propagates session.roleVersion to UserSession.roleVersion", async () => {
    const getServerSession = await loadGetServerSession()

    const result = await getServerSession()

    expect(result).not.toBeNull()
    // roleVersion must round-trip so refresh-session can compare it against
    // dbRoleVersion and only force re-auth on actual role changes.
    expect(result!.roleVersion).toBe(STUB_ROLE_VERSION)
  })

  it("sets UserSession.roleVersion to undefined when session.roleVersion is absent", async () => {
    const getServerSession = await loadGetServerSession({ roleVersion: undefined })

    const result = await getServerSession()

    expect(result).not.toBeNull()
    // undefined is correct here; refresh-session treats undefined as 0 via || 0
    expect(result!.roleVersion).toBeUndefined()
  })

  it("propagates all critical session fields together", async () => {
    const getServerSession = await loadGetServerSession()

    const result = await getServerSession()

    expect(result!.sub).toBe(STUB_SUB)
    expect(result!.iat).toBe(STUB_IAT)
    expect(result!.roleVersion).toBe(STUB_ROLE_VERSION)
    expect(result!.idToken).toBe("id-token-value")
  })
})
