/**
 * Pins the load-bearing contract that GET /api/auth/refresh-session bypasses the
 * polling session cache entirely.  The route exists specifically so role revocations
 * propagate to every Cloud Run instance within a single poll cycle — if it ever
 * started reading from the 5-minute in-process cache, stale roles would survive
 * across role-change events on all but the instance that handled the admin action.
 *
 * See the doc comment in app/api/auth/refresh-session/route.ts for full rationale.
 */

import { NextResponse } from 'next/server'
import { GET } from '@/app/api/auth/refresh-session/route'
import { getServerSession } from '@/lib/auth/server-session'
import { getUserByCognitoSub } from '@/lib/db/drizzle'
import { pollingSessionCache } from '@/lib/auth/polling-session-cache'

jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn(),
}))

jest.mock('@/lib/db/drizzle', () => ({
  getUserByCognitoSub: jest.fn(),
}))

jest.mock('@/lib/auth/polling-session-cache', () => ({
  pollingSessionCache: {
    getCachedSession: jest.fn(),
    setCachedSession: jest.fn(),
    invalidateSession: jest.fn(),
    invalidateUser: jest.fn(),
  },
  generateSessionCacheKey: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
}))

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>
const mockGetUserByCognitoSub = getUserByCognitoSub as jest.MockedFunction<typeof getUserByCognitoSub>
const mockCache = pollingSessionCache as jest.Mocked<typeof pollingSessionCache>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSession(roleVersion = 1): any {
  return {
    sub: 'google-oauth2|abc123',
    email: 'user@example.com',
    roleVersion,
    loginIat: 1_700_000_000,
  }
}

describe('GET /api/auth/refresh-session — polling-cache bypass', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('never calls pollingSessionCache.getCachedSession — always reads live JWT', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(1) as never)
    mockGetUserByCognitoSub.mockResolvedValue({ roleVersion: 1 } as never)

    await GET()

    expect(mockCache.getCachedSession).not.toHaveBeenCalled()
  })

  it('never calls pollingSessionCache.setCachedSession — does not warm the cache', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(1) as never)
    mockGetUserByCognitoSub.mockResolvedValue({ roleVersion: 1 } as never)

    await GET()

    expect(mockCache.setCachedSession).not.toHaveBeenCalled()
  })

  it('returns needsRefresh:false when roleVersions match', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(3) as never)
    mockGetUserByCognitoSub.mockResolvedValue({ roleVersion: 3 } as never)

    const response = await GET() as NextResponse
    const body = await response.json()

    expect(body.needsRefresh).toBe(false)
  })

  it('returns needsRefresh:true when DB roleVersion differs from JWT', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(1) as never)
    mockGetUserByCognitoSub.mockResolvedValue({ roleVersion: 2 } as never)

    const response = await GET() as NextResponse
    const body = await response.json()

    expect(body.needsRefresh).toBe(true)
  })

  it('returns needsRefresh:false on DB error — cache not consulted as fallback', async () => {
    mockGetServerSession.mockResolvedValue(makeSession(1) as never)
    mockGetUserByCognitoSub.mockRejectedValue(new Error('connection timeout'))

    const response = await GET() as NextResponse
    const body = await response.json()

    expect(body.needsRefresh).toBe(false)
    // Cache must not be consulted as a fallback when the DB errors.
    expect(mockCache.getCachedSession).not.toHaveBeenCalled()
  })
})
