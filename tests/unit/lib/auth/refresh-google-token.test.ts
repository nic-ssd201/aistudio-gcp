/**
 * Unit tests for refreshGoogleToken (lib/auth/refresh-google-token.ts)
 *
 * Tests the Google OAuth2 refresh-token grant path in isolation by mocking
 * the global `fetch`. Covers the paths identified in the PR #5 code review:
 * - Happy path: token fields updated correctly
 * - Refresh-token rotation: new refresh_token preserved when Google returns one
 * - Missing expires_in: default to 1 hour, not the old expired timestamp
 * - expires_in = 0: floor prevents immediate re-refresh loop
 * - Error response from Google (invalid_grant): returns null
 * - Missing AUTH_GOOGLE_ID at refresh time: returns null with error log (no fetch)
 * - Missing AUTH_GOOGLE_SECRET at refresh time: returns null with error log (no fetch)
 */

import { refreshGoogleToken, getActiveRefreshCount } from "@/lib/auth/refresh-google-token"

const MOCK_REFRESH_TOKEN = "mock-refresh-token-value"
const MOCK_ACCESS_TOKEN = "mock-access-token-new"
const MOCK_ID_TOKEN = "mock-id-token-new"
const MOCK_NEW_REFRESH_TOKEN = "mock-rotated-refresh-token"

// Stub out edge-logger so the module doesn't need Next.js internals
jest.mock("@/lib/auth/edge-logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

// Helper: build a minimal JWT token
function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    sub: "user-123",
    provider: "google" as const,
    refreshToken: MOCK_REFRESH_TOKEN,
    expiresAt: Date.now() - 1000, // already expired
    ...overrides,
  }
}

// Helper: mock a successful Google token response
function mockGoogleTokenResponse(body: Record<string, unknown>, ok = true) {
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok,
    json: jest.fn().mockResolvedValueOnce(body),
  } as unknown as Response)
}

describe("refreshGoogleToken", () => {
  const ORIG_ENV = process.env

  beforeEach(() => {
    jest.resetAllMocks()
    process.env = {
      ...ORIG_ENV,
      AUTH_GOOGLE_ID: "test-google-client-id",
      AUTH_GOOGLE_SECRET: "test-google-client-secret",
    }
  })

  afterEach(() => {
    process.env = ORIG_ENV
  })

  it("returns updated token on success", async () => {
    const before = Date.now()
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })

    const token = makeToken()
    const result = await refreshGoogleToken(token)

    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe(MOCK_ACCESS_TOKEN)
    expect(result!.idToken).toBe(MOCK_ID_TOKEN)
    // refresh_token unchanged when Google doesn't return one
    expect(result!.refreshToken).toBe(MOCK_REFRESH_TOKEN)
    // expiresAt is ~1 hour in the future
    expect(result!.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })

  it("preserves a rotated refresh_token from Google's response", async () => {
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      refresh_token: MOCK_NEW_REFRESH_TOKEN,
      expires_in: 3600,
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result!.refreshToken).toBe(MOCK_NEW_REFRESH_TOKEN)
  })

  it("returns null (fail-closed) when expires_in is absent", async () => {
    // Previously this defaulted to 3600 s, but a missing expires_in is
    // structurally abnormal. With a 5-min proactive-refresh threshold, any
    // token lifetime < 300 s would trigger a refresh on the very next request —
    // a misbehaving upstream could cause a hot-loop hitting Google's endpoint
    // once per minute per user. Returning null forces a single re-auth instead.
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      // expires_in intentionally omitted — treated as 0 (< 300 s floor)
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null (fail-closed) when expires_in is below the 300 s minimum", async () => {
    // expires_in=0 used to be floored to 60 s; it now causes fail-closed to
    // avoid hot-looping against Google's token endpoint when upstream misbehaves.
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 0,
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("accepts expires_in at the 300 s minimum", async () => {
    const before = Date.now()
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 300,
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result).not.toBeNull()
    expect(result!.expiresAt).toBeGreaterThanOrEqual(before + 300 * 1000)
  })

  it("returns null (fail-closed) when expires_in is exactly 1 s below MIN_EXPIRES_IN (299 s)", async () => {
    // Boundary pin: 299 s is one tick below the 300 s minimum and must be rejected.
    // If MIN_EXPIRES_IN ever slips to 298 s or the comparison flips to <=, this test catches it.
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 299,
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null on Google error response (invalid_grant)", async () => {
    mockGoogleTokenResponse({ error: "invalid_grant" }, false)

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null on non-ok HTTP response", async () => {
    mockGoogleTokenResponse({ error: "server_error" }, false)

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null when fetch throws", async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error("Network failure"))

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null when refreshToken is absent on the JWT", async () => {
    const result = await refreshGoogleToken({ sub: "user-123", provider: "google" })

    expect(result).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns null when AUTH_GOOGLE_ID is missing", async () => {
    delete process.env.AUTH_GOOGLE_ID
    global.fetch = jest.fn()

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns null when AUTH_GOOGLE_SECRET is missing", async () => {
    delete process.env.AUTH_GOOGLE_SECRET
    global.fetch = jest.fn()

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("returns null (fail-closed) when Google returns 200 but access_token is absent", async () => {
    // A 200 response without access_token is structurally malformed.
    // Silently storing undefined would break downstream auth checks.
    mockGoogleTokenResponse({
      // access_token intentionally omitted
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null (fail-closed) when Google returns 200 but id_token is absent", async () => {
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      // id_token intentionally omitted
      expires_in: 3600,
    })

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
  })

  it("returns null (fail-closed) when the AbortController 10 s timeout fires", async () => {
    // Simulate a hung Google token endpoint: fetch never resolves, the 10 s
    // AbortController fires, and refreshGoogleToken returns null so the caller
    // can force re-auth rather than waiting indefinitely.
    jest.useFakeTimers()

    global.fetch = jest.fn().mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Wire the AbortSignal so abort() actually rejects the promise.
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.")
            err.name = "AbortError"
            reject(err)
          })
        })
    )

    const refreshPromise = refreshGoogleToken(makeToken())
    // Advance time past the 10 s abort threshold.
    jest.advanceTimersByTime(11_000)
    const result = await refreshPromise

    expect(result).toBeNull()

    jest.useRealTimers()
  })

  it("deduplicates concurrent refresh calls for the same user", async () => {
    // Only one fetch response is queued — if both concurrent calls went to
    // the network, the second would get undefined and the test would fail.
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })

    const token = makeToken()
    // Launch two concurrent refreshes without yielding between them.
    const [result1, result2] = await Promise.all([
      refreshGoogleToken(token),
      refreshGoogleToken(token),
    ])

    // Google's token endpoint must have been called exactly once.
    expect(global.fetch).toHaveBeenCalledTimes(1)
    // Both callers receive the same refreshed token.
    expect(result1).not.toBeNull()
    expect(result2).not.toBeNull()
    expect(result1!.accessToken).toBe(MOCK_ACCESS_TOKEN)
    expect(result2!.accessToken).toBe(MOCK_ACCESS_TOKEN)

    // The dedup map must be empty after both Promises settle.
    // The identity-check .finally() in refreshGoogleToken() is the only
    // mechanism keeping activeRefreshes bounded under load — a regression
    // that strands entries would silently degrade to a 500-entry safety-cap leak.
    expect(getActiveRefreshCount()).toBe(0)
  })

  it("falls through to normal dedup path when the activeRefreshes map is at capacity (≥500 entries)", async () => {
    // Regression pin: when the dedup map holds ≥500 entries, refreshGoogleToken()
    // emits a throttled warn but still falls through to the normal dedup path —
    // it inserts the new session's Promise (letting the map briefly exceed 500)
    // rather than bypassing the map.  Bypassing would let N concurrent callers
    // for the same session each issue an independent fetch, racing refresh_token
    // rotation.

    // Seed the map with 500 in-flight Promises.  Each dummy token has a unique
    // dedupKey (sub without loginIat = just 'cap-dummy-N', none collide with
    // makeToken()'s dedupKey 'user-123').  We use mockRejectedValue so the fetch
    // calls resolve quickly and the dummy .finally() callbacks can clean up the
    // map entries after our assertions.
    // Crucially: all 500 fetch() calls are issued SYNCHRONOUSLY before any await,
    // so the map stays full when we check getActiveRefreshCount() below.
    global.fetch = jest.fn().mockRejectedValue(new Error('cap-test dummy'))

    const dummyPromises: Promise<unknown>[] = []
    for (let i = 0; i < 500; i++) {
      dummyPromises.push(
        refreshGoogleToken({
          sub: `cap-dummy-${i}`,
          provider: 'google' as const,
          refreshToken: MOCK_REFRESH_TOKEN,
          expiresAt: Date.now() - 1000,
        })
      )
    }

    // No await has happened yet — all 500 sessions are in the map synchronously.
    expect(getActiveRefreshCount()).toBe(500)

    // Replace fetch so the real token's doRefresh() gets a successful response.
    // The dummy fetch() calls have already been issued to the reject mock above;
    // this replacement only affects new calls (i.e., the real token below).
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })

    // Map is at capacity but 'user-123' is not already there → falls through and
    // inserts a new entry (map briefly at 501), then doRefresh() runs successfully.
    const result = await refreshGoogleToken(makeToken()) // dedupKey='user-123'

    // Fall-through path called doRefresh() and the real token was refreshed.
    expect(result).not.toBeNull()
    expect(result!.accessToken).toBe(MOCK_ACCESS_TOKEN)

    // Settle dummies so their .finally() callbacks clean up the map entries.
    await Promise.allSettled(dummyPromises)
    expect(getActiveRefreshCount()).toBe(0)
  })

  it("deduplicates concurrent refreshes for the same sub+loginIat (cross-device isolation)", async () => {
    // Two sessions from the same Google account (same sub, different loginIat —
    // e.g. two browsers) each expire at the same instant.  With sub:loginIat
    // keying they must each get their own Promise and their own fetch().
    // (If they shared one Promise the second session's loginIat would be overwritten
    // by the first session's spread — breaking the polling-session-cache key.)

    const SESSION_A_IAT = 1_700_000_000
    const SESSION_B_IAT = 1_700_001_000
    const ACCESS_TOKEN_A = "access-token-session-a"
    const ACCESS_TOKEN_B = "access-token-session-b"

    const tokenA = makeToken({ loginIat: SESSION_A_IAT })
    const tokenB = makeToken({ loginIat: SESSION_B_IAT })

    // Queue two distinct responses — one for each session's fetch().
    // mockGoogleTokenResponse replaces fetch entirely each call, so we chain:
    // first call to fetch → A's response, second call → B's response.
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ access_token: ACCESS_TOKEN_A, id_token: MOCK_ID_TOKEN, expires_in: 3600 }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({ access_token: ACCESS_TOKEN_B, id_token: MOCK_ID_TOKEN, expires_in: 3600 }),
      } as unknown as Response)

    const [resultA, resultB] = await Promise.all([
      refreshGoogleToken(tokenA),
      refreshGoogleToken(tokenB),
    ])

    // Both sessions must have hit the network independently.
    expect(global.fetch).toHaveBeenCalledTimes(2)
    // Each session gets its own token — no loginIat clobber.
    expect(resultA).not.toBeNull()
    expect(resultB).not.toBeNull()
    expect(resultA!.accessToken).toBe(ACCESS_TOKEN_A)
    expect(resultB!.accessToken).toBe(ACCESS_TOKEN_B)
    expect(resultA!.loginIat).toBe(SESSION_A_IAT)
    expect(resultB!.loginIat).toBe(SESSION_B_IAT)
    expect(getActiveRefreshCount()).toBe(0)
  })

  it("deduplicates concurrent refreshes for the same sub+loginIat (same-session dedup still works)", async () => {
    // Two concurrent refreshes from the SAME session (same sub + same loginIat)
    // must still share one Promise — only one fetch should be issued.
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })

    const SHARED_IAT = 1_700_000_000
    const token = makeToken({ loginIat: SHARED_IAT })

    const [result1, result2] = await Promise.all([
      refreshGoogleToken(token),
      refreshGoogleToken(token),
    ])

    expect(global.fetch).toHaveBeenCalledTimes(1) // shared Promise → single fetch
    expect(result1).not.toBeNull()
    expect(result2).not.toBeNull()
    expect(result1!.accessToken).toBe(MOCK_ACCESS_TOKEN)
    expect(result2!.accessToken).toBe(MOCK_ACCESS_TOKEN)
    expect(getActiveRefreshCount()).toBe(0)
  })

  it("sequential refreshes each hit the network (no stale dedup join)", async () => {
    const SECOND_ACCESS_TOKEN = "second-access-token"

    const token = makeToken()

    // First refresh: queue one mock response, await it, confirm map is clear.
    // mockGoogleTokenResponse replaces global.fetch entirely, so queue each
    // response separately — before the call that will consume it.
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })
    const result1 = await refreshGoogleToken(token)
    expect(result1).not.toBeNull()
    expect(getActiveRefreshCount()).toBe(0) // .finally() cleanup ran

    // Second refresh: queue a fresh mock and call again.  The dedup map must
    // create a new entry rather than joining the already-settled Promise from
    // the first call — if it joined a stale entry, result2 would be the first
    // call's value (MOCK_ACCESS_TOKEN), not SECOND_ACCESS_TOKEN.
    mockGoogleTokenResponse({
      access_token: SECOND_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 3600,
    })
    const result2 = await refreshGoogleToken(token)
    expect(result2).not.toBeNull()
    expect(result2!.accessToken).toBe(SECOND_ACCESS_TOKEN)
    expect(getActiveRefreshCount()).toBe(0) // map cleared after second settlement
    expect(global.fetch).toHaveBeenCalledTimes(1) // each mockGoogleTokenResponse resets fetch
  })
})
