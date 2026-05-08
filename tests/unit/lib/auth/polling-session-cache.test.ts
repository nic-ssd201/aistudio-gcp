/**
 * Unit tests for PollingSessionCache and generateSessionCacheKey.
 *
 * Covered paths:
 * - Cache hit on second call (cache is actually caching — regression pin for
 *   the broken-loginIat bug where the cache was a permanent miss)
 * - Cache miss for an unknown key
 * - loginIat-keyed entries don't collide across re-authentications within TTL
 * - invalidateUser removes all entries for a given sub (across loginIat values)
 * - invalidateSession removes a specific entry
 * - Expired entries return null (TTL enforcement)
 * - generateSessionCacheKey format includes sub and loginIat
 * - generateSessionCacheKey returns null when loginIat is absent/0 (fail-closed)
 */

import { PollingSessionCache, generateSessionCacheKey } from "@/lib/auth/polling-session-cache"
import type { UserSession } from "@/lib/auth/server-session"

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    sub: "user-123",
    email: "user@example.com",
    loginIat: 1_700_000_000,
    ...overrides,
  }
}

// ── PollingSessionCache ────────────────────────────────────────────────────────

describe("PollingSessionCache", () => {
  let cache: PollingSessionCache

  beforeEach(() => {
    // Long cleanup interval so the setInterval never fires during tests.
    cache = new PollingSessionCache({ maxAge: 5 * 60 * 1000, cleanupInterval: 600_000 })
  })

  afterEach(() => {
    // Destroy the cache to clear the cleanup setInterval and avoid timer leaks.
    cache.destroy()
  })

  // ── Cache hit regression test ──────────────────────────────────────────────

  it("returns cached result on second call — cache is actually caching (regression pin for broken-loginIat bug)", () => {
    const session = makeSession()
    // Non-null assertion: makeSession() always produces a non-zero loginIat.
    const key = generateSessionCacheKey(session)!

    cache.setCachedSession(key, session, 42, ["student"])

    const hit = cache.getCachedSession(key)

    expect(hit).not.toBeNull()
    expect(hit!.userId).toBe(42)
    expect(hit!.userRoles).toEqual(["student"])
    // requestCount starts at 1 (set) and is incremented to 2 on get
    expect(hit!.requestCount).toBe(2)
  })

  it("returns null on cache miss", () => {
    const session = makeSession()
    const key = generateSessionCacheKey(session)!

    expect(cache.getCachedSession(key)).toBeNull()
  })

  // ── loginIat-keyed collision prevention ───────────────────────────────────

  it("different loginIat values produce different keys — re-auth within TTL gets a fresh cache miss", () => {
    const firstSession = makeSession({ loginIat: 1_000_000 })
    const secondSession = makeSession({ loginIat: 1_000_001 }) // simulates re-login

    const firstKey = generateSessionCacheKey(firstSession)!
    const secondKey = generateSessionCacheKey(secondSession)!

    expect(firstKey).not.toBe(secondKey)

    cache.setCachedSession(firstKey, firstSession, 42, ["student"])

    // The re-authenticated session must NOT see the old cached entry.
    expect(cache.getCachedSession(secondKey)).toBeNull()
  })

  // ── invalidateUser ─────────────────────────────────────────────────────────

  it("invalidateUser removes all entries for the sub regardless of loginIat", () => {
    const s1 = makeSession({ loginIat: 1_000_000 })
    const s2 = makeSession({ loginIat: 1_000_001 })
    const otherUser = makeSession({ sub: "other-user", loginIat: 1_000_000 })

    cache.setCachedSession(generateSessionCacheKey(s1)!, s1, 42, ["student"])
    cache.setCachedSession(generateSessionCacheKey(s2)!, s2, 42, ["administrator"])
    cache.setCachedSession(generateSessionCacheKey(otherUser)!, otherUser, 99, ["staff"])

    cache.invalidateUser("user-123")

    expect(cache.getCachedSession(generateSessionCacheKey(s1)!)).toBeNull()
    expect(cache.getCachedSession(generateSessionCacheKey(s2)!)).toBeNull()
    // Other users are unaffected.
    expect(cache.getCachedSession(generateSessionCacheKey(otherUser)!)).not.toBeNull()
  })

  it("invalidateUser handles the legacy session:sub (no loginIat) key format", () => {
    // Simulate an entry cached with the old key format (pre-loginIat migration).
    const legacyKey = "session:user-123"
    const session = makeSession()
    cache.setCachedSession(legacyKey, session, 42, ["student"])

    cache.invalidateUser("user-123")

    expect(cache.getCachedSession(legacyKey)).toBeNull()
  })

  // ── invalidateSession ──────────────────────────────────────────────────────

  it("invalidateSession removes a specific key only", () => {
    const s1 = makeSession({ loginIat: 1_000_000 })
    const s2 = makeSession({ loginIat: 1_000_001 })
    const key1 = generateSessionCacheKey(s1)!
    const key2 = generateSessionCacheKey(s2)!

    cache.setCachedSession(key1, s1, 42, ["student"])
    cache.setCachedSession(key2, s2, 42, ["student"])

    cache.invalidateSession(key1)

    expect(cache.getCachedSession(key1)).toBeNull()
    // key2 must be untouched.
    expect(cache.getCachedSession(key2)).not.toBeNull()
  })

  // ── FIFO eviction ─────────────────────────────────────────────────────────

  it("evictOldest() respects delete-before-set: re-cached key is treated as newest, not oldest", () => {
    // Pin the evictOldest() + delete-before-set invariant documented in
    // setCachedSession():
    //   - Insert keys A, B, C (FIFO order: A is oldest).
    //   - Re-set key B (delete + re-insert → B moves to tail).
    //   - On the next insert that triggers eviction, A must be evicted, not B.
    //
    // If setCachedSession() used Map.set() without a preceding delete(), B
    // would keep its original insertion position (between A and C) and the
    // eviction order would silently become A → B, wrongly evicting an entry
    // that was just refreshed.
    const tinyCache = new PollingSessionCache({
      maxAge: 5 * 60 * 1000,
      maxEntries: 3,
      cleanupInterval: 600_000,
    })

    const sA = makeSession({ sub: "a", loginIat: 1_000_001 })
    const sB = makeSession({ sub: "b", loginIat: 1_000_002 })
    const sC = makeSession({ sub: "c", loginIat: 1_000_003 })
    const sD = makeSession({ sub: "d", loginIat: 1_000_004 })

    const keyA = generateSessionCacheKey(sA)!
    const keyB = generateSessionCacheKey(sB)!
    const keyC = generateSessionCacheKey(sC)!
    const keyD = generateSessionCacheKey(sD)!

    tinyCache.setCachedSession(keyA, sA, 1, ["student"])  // map: [A, B_placeholder, C_placeholder]
    tinyCache.setCachedSession(keyB, sB, 2, ["student"])  // map: [A, B, ...]
    tinyCache.setCachedSession(keyC, sC, 3, ["student"])  // map: [A, B, C] — full

    // Re-cache B: delete-before-set moves B to the tail → [A, C, B].
    tinyCache.setCachedSession(keyB, sB, 2, ["administrator"])

    // Inserting D triggers eviction.  A is now the oldest entry — it must be
    // evicted, not B (which was just re-inserted at the tail).
    tinyCache.setCachedSession(keyD, sD, 4, ["student"])

    expect(tinyCache.getCachedSession(keyA)).toBeNull()   // evicted (oldest)
    expect(tinyCache.getCachedSession(keyB)).not.toBeNull() // survived (recently re-cached)
    expect(tinyCache.getCachedSession(keyC)).not.toBeNull() // survived
    expect(tinyCache.getCachedSession(keyD)).not.toBeNull() // just inserted

    tinyCache.destroy()
  })

  // ── setCachedSession copies the roles array ────────────────────────────────

  it("setCachedSession copies the roles array — post-call mutations do not corrupt the cached entry", () => {
    const session = makeSession()
    const key = generateSessionCacheKey(session)!
    const roles = ["student"]

    cache.setCachedSession(key, session, 42, roles)

    // Mutate the caller's array after caching.
    roles.push("administrator")

    // The cached entry must still reflect the original roles.
    const hit = cache.getCachedSession(key)
    expect(hit!.userRoles).toEqual(["student"])
    expect(hit!.userRoles).toHaveLength(1)
  })

  // ── TTL enforcement ────────────────────────────────────────────────────────

  it("returns null when the entry has expired", () => {
    // Use fake timers instead of a real setTimeout — the original `await new
    // Promise(resolve => setTimeout(resolve, 20))` is flaky on slow CI where
    // the 20 ms wall-clock delay may not reliably exceed a 1 ms TTL.
    jest.useFakeTimers()

    const shortLivedCache = new PollingSessionCache({ maxAge: 1, cleanupInterval: 600_000 })
    const session = makeSession()
    const key = generateSessionCacheKey(session)!

    shortLivedCache.setCachedSession(key, session, 42, ["student"])

    // Advance the fake clock past the 1 ms TTL.
    jest.advanceTimersByTime(10)

    expect(shortLivedCache.getCachedSession(key)).toBeNull()
    shortLivedCache.destroy()

    jest.useRealTimers()
  })
})

// ── generateSessionCacheKey ────────────────────────────────────────────────────

describe("generateSessionCacheKey", () => {
  it("includes sub and loginIat in the returned key", () => {
    const session = makeSession({ sub: "abc", loginIat: 1_700_000_000 })
    expect(generateSessionCacheKey(session)).toBe("session:abc:1700000000")
  })

  it("returns null when loginIat is absent — fail-closed to prevent session:sub:0 collision", () => {
    // Rationale: if loginIat propagation breaks, every session for a sub would
    // map to the same key session:sub:0. Two concurrent sessions could serve
    // stale roles from each other's cache entry. Returning null tells callers
    // to skip the cache entirely rather than risk a cross-session collision.
    const session: UserSession = { sub: "abc" }
    expect(generateSessionCacheKey(session)).toBeNull()
  })

  it("returns null when loginIat is 0 — same fail-closed logic as absent loginIat", () => {
    // loginIat=0 is treated identically to absent: the degenerate key session:sub:0
    // would collide across all zero-loginIat sessions for the same sub.
    const session = makeSession({ loginIat: 0 })
    expect(generateSessionCacheKey(session)).toBeNull()
  })
})
