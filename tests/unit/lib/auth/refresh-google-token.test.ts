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
 * - Missing AUTH_GOOGLE_SECRET at refresh time: returns null with error log
 */

import { refreshGoogleToken } from "@/lib/auth/refresh-google-token"

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

  it("uses 1-hour default when expires_in is absent", async () => {
    const before = Date.now()
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      // expires_in intentionally omitted
    })

    const result = await refreshGoogleToken(makeToken())

    // Should be ~1 hour from now, not the token's old (expired) expiresAt
    expect(result!.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })

  it("floors expires_in=0 to 60 s, preventing an immediate re-refresh loop", async () => {
    const before = Date.now()
    mockGoogleTokenResponse({
      access_token: MOCK_ACCESS_TOKEN,
      id_token: MOCK_ID_TOKEN,
      expires_in: 0,
    })

    const result = await refreshGoogleToken(makeToken())

    // Must be at least 60 s in the future (the floor)
    expect(result!.expiresAt).toBeGreaterThanOrEqual(before + 60 * 1000)
    // Must NOT be ~1 hour — confirming the floor, not the default
    expect(result!.expiresAt).toBeLessThan(before + 3600 * 1000)
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

  it("returns null when AUTH_GOOGLE_SECRET is missing", async () => {
    delete process.env.AUTH_GOOGLE_SECRET
    global.fetch = jest.fn()

    const result = await refreshGoogleToken(makeToken())

    expect(result).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
