/**
 * High-performance session cache for polling operations
 * Eliminates redundant auth checks during long-running operations
 */

import { createLogger } from '@/lib/logger';
import type { UserSession } from '@/lib/auth/server-session';
import { POLLING_CACHE_MAX_ENTRIES } from '@/lib/auth/token-refresh-config';

const log = createLogger({ module: 'polling-session-cache' });

interface CachedSession {
  session: UserSession;
  userId: number;
  userRoles: string[];
  cachedAt: number;
  expiresAt: number;
  requestCount: number;
}

interface SessionCacheOptions {
  maxAge?: number; // Cache duration in ms (default: 5 minutes)
  maxEntries?: number; // Max cached sessions (default: 500)
  cleanupInterval?: number; // Cleanup frequency in ms (default: 2 minutes)
}

export class PollingSessionCache {
  private cache = new Map<string, CachedSession>();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly options: Required<SessionCacheOptions>;

  constructor(options: SessionCacheOptions = {}) {
    this.options = {
      maxAge: options.maxAge || 5 * 60 * 1000, // 5 minutes
      maxEntries: options.maxEntries || 500,
      cleanupInterval: options.cleanupInterval || 2 * 60 * 1000, // 2 minutes
    };

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Get cached session for a user, bypassing auth checks if valid.
   *
   * **Side effect**: increments `entry.requestCount` on every cache hit for
   * metrics purposes.  The returned object is the live cache entry (not a copy),
   * so callers must not mutate it.
   */
  // Returns Readonly<CachedSession> for compile-time mutation prevention.
  // Object.freeze() is intentionally NOT applied: the returned object is the
  // live cache entry, and getCachedSession itself mutates entry.requestCount++
  // for metrics.  Freezing the entry here would make the next call's
  // requestCount++ a silent no-op (non-strict) or throw (strict mode).
  // The TypeScript Readonly type is sufficient to prevent caller mutations at
  // the type-checking layer.
  getCachedSession(sessionId: string): Readonly<CachedSession> | null {
    const cached = this.cache.get(sessionId);

    if (!cached) {
      return null;
    }

    const now = Date.now();

    // Check if cache entry is expired
    if (now > cached.expiresAt) {
      this.cache.delete(sessionId);
      log.debug('Cache entry expired', { sessionId, age: now - cached.cachedAt });
      return null;
    }

    // Update request count for metrics
    cached.requestCount++;

    log.debug('Cache hit', {
      sessionId,
      userId: cached.userId,
      requestCount: cached.requestCount,
      age: now - cached.cachedAt
    });

    return cached;
  }

  /**
   * Cache session data for future polling requests
   */
  setCachedSession(
    sessionId: string,
    session: UserSession,
    userId: number,
    userRoles: string[]
  ): void {
    const now = Date.now();

    // FIFO eviction when cache is full: evicts the entry with the oldest
    // cachedAt (creation time), not the least-recently-accessed.  For a
    // 5-min TTL the difference is small in practice; true LRU would require
    // tracking lastAccessedAt and is not worth the overhead here.
    if (this.cache.size >= this.options.maxEntries) {
      this.evictOldest();
    }

    // Delete-before-set: if sessionId already exists in the Map, Map.set()
    // updates the value in place but preserves the entry's original insertion
    // position.  A second session for the same key (e.g. after a cache-miss
    // on a refreshed session) would therefore appear "older" than entries
    // inserted after the original, breaking evictOldest()'s FIFO invariant.
    // Deleting first forces re-insertion at the tail so the entry sorts as
    // "newest" — consistent with the "just cached" semantics of this call.
    this.cache.delete(sessionId);
    this.cache.set(sessionId, {
      session,
      userId,
      userRoles,
      cachedAt: now,
      expiresAt: now + this.options.maxAge,
      requestCount: 1
    });

    log.debug('Session cached', {
      sessionId,
      userId,
      roleCount: userRoles.length,
      cacheSize: this.cache.size
    });
  }

  /**
   * Invalidate a specific cache entry by its full key.
   */
  invalidateSession(sessionId: string): void {
    const deleted = this.cache.delete(sessionId);
    if (deleted) {
      log.info('Session cache invalidated', { sessionId });
    }
  }

  /**
   * Invalidate ALL polling cache entries for a given user `sub`.
   *
   * Because the cache is keyed on `session:${sub}:${iat}`, a single user may
   * have multiple entries (one per distinct login within the TTL window).
   * This method scans for all matching prefixes and removes them — use it
   * from role-change actions so revocations propagate immediately rather
   * than waiting for the 5-minute TTL to expire.
   *
   * Also handles the legacy `session:${sub}` (no iat) format in case any
   * entries were cached before the key format was updated.
   *
   * **Complexity:** O(N) where N is the total number of cached entries (up to
   * `maxEntries`, default 500). This is acceptable for an admin-triggered
   * operation that runs at most once per role-change event.  Do not call from
   * a hot path (e.g. per-request middleware).
   *
   * **Multi-instance note:** this method only flushes the in-process cache of
   * the instance that handles the role-change request.  On Cloud Run (or any
   * deployment with N > 1 instances), the other N-1 instances continue serving
   * stale roles for up to 5 minutes (the TTL).  This is the accepted trade-off
   * for the polling-auth perf improvement; a cross-instance invalidation signal
   * (e.g. Pub/Sub or a shared Redis cache) would eliminate the window if
   * sub-5-minute revocation propagation becomes a hard requirement.
   */
  // HOT_PATH_UNSAFE: O(N) over all cache entries.
  // Acceptable today because invalidateUser() is only called from admin-triggered
  // role-change operations (updateUser / deleteUser) — never on a hot request path.
  // If a future cross-instance invalidation (e.g. Pub/Sub-driven) calls this on
  // every incoming request, replace with a sub-keyed Map<sub, Map<key, entry>>
  // to make invalidation O(sessions-per-user) instead of O(total-sessions).
  invalidateUser(sub: string): void {
    const prefix = `session:${sub}:`;
    // Legacy key (pre-iat format): no current code path writes entries under
    // this key — generateSessionCacheKey() always produces session:sub:iat and
    // returns null (skipping caching) when iat is absent.  Kept for migration
    // safety in case a pre-deploy cookie populates the cache before the iat
    // fix lands; a future cleanup PR may remove this branch once confident
    // that no legacy entries remain in any deployment.
    const legacyKey = `session:${sub}`;
    let count = 0;

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) || key === legacyKey) {
        this.cache.delete(key);
        count++;
      }
    }

    if (count > 0) {
      log.info('Polling cache entries invalidated for user', { sub, count });
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats() {
    const now = Date.now();
    let totalRequests = 0;
    let validEntries = 0;

    for (const entry of this.cache.values()) {
      if (now <= entry.expiresAt) {
        validEntries++;
        totalRequests += entry.requestCount;
      }
    }

    return {
      totalEntries: this.cache.size,
      validEntries,
      totalRequests,
      hitRate: validEntries > 0 ? (totalRequests / validEntries).toFixed(2) : '0.00',
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  private evictOldest(): void {
    // Map preserves insertion order, so the first key is always the oldest
    // by creation time — identical semantics to the previous O(N) min-scan
    // over cachedAt, but O(1) instead.
    //
    // Assumption: setCachedSession always inserts new keys (Map.set appends);
    // it does not update an existing key in-place.  If a future change ever
    // updates an entry for an existing sessionId without deleting+re-inserting
    // first, that entry would retain its original insertion position and the
    // "first key = oldest" invariant would silently break (a newer session
    // could be evicted ahead of an older one).  Keep this in mind if
    // setCachedSession's write pattern ever changes.
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
      log.debug('Evicted oldest cache entry', { sessionId: oldestKey });
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.cache.entries()) {
        if (now > entry.expiresAt) {
          this.cache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        log.debug('Cache cleanup completed', { cleaned, remaining: this.cache.size });
      }
    }, this.options.cleanupInterval);
  }

  private estimateMemoryUsage(): string {
    // 500 B/entry is a conservative lower-bound estimate for a CachedSession that
    // carries a UserSession (sub + email + iat), a userId, a userRoles string[],
    // and the cachedAt/expiresAt/requestCount numbers.  A session with a long
    // roles array or long email addresses can exceed this.  Treat the returned
    // value as an order-of-magnitude indicator, not a precise accounting.
    const avgEntrySize = 500; // bytes — see comment above
    const totalBytes = this.cache.size * avgEntrySize;

    if (totalBytes < 1024) return `${totalBytes}B`;
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)}KB`;
    return `${(totalBytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
    log.info('Session cache destroyed');
  }
}

// Singleton instance for application-wide use.
//
// Stored on globalThis to survive Next.js HMR module reloads in development.
// Without this, every hot-reload registers a new setInterval (from startCleanup)
// while the old interval is never cleared (destroy() is only called in tests),
// causing timer accumulation and stale cache entries surviving across reloads.
// globalThis persists across HMR reloads within the same Node process, so the
// single instance (and its interval) is reused rather than duplicated.
// In production there is no HMR; the pattern is a no-op (just reads the cached
// value on every import).
declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires var
  var __pollingSessionCache__: PollingSessionCache | undefined
}

export const pollingSessionCache: PollingSessionCache =
  globalThis.__pollingSessionCache__ ??
  (globalThis.__pollingSessionCache__ = new PollingSessionCache({
    maxAge: 5 * 60 * 1000, // 5 minutes - longer than typical polling sessions
    maxEntries: POLLING_CACHE_MAX_ENTRIES, // shared with refresh-google-token.ts dedup cap
    cleanupInterval: 2 * 60 * 1000, // 2 minutes
  }));

/**
 * Generate cache key from session data.
 *
 * Keyed on `sub:iat` to prevent cross-session collisions: if a user signs out
 * and back in within the 5-minute TTL window, the new login produces a fresh
 * `iat` (issued-at), so the cache entry for the previous session is bypassed
 * automatically — without needing an explicit invalidation on sign-out.
 *
 * `iat` is propagated from the JWT's `loginIat` custom claim through the NextAuth
 * session callback and `getServerSession()`.  A missing or zero iat indicates
 * broken propagation — in that case we return `null` so callers skip the cache
 * entirely rather than caching under the degenerate key `session:sub:0`.
 *
 * Fail-closed: a cache miss on every request is preferable to multiple concurrent
 * sessions for the same sub sharing one entry and potentially receiving stale roles.
 *
 * @returns The cache key string, or `null` when `iat` is absent or zero
 *          (treat as cache miss — do not call getCachedSession with the result).
 */
export function generateSessionCacheKey(session: UserSession): string | null {
  if (!session.iat) {
    // iat is absent or 0 — skip caching to avoid the degenerate key collision
    // where every session for a sub maps to session:sub:0 and cross-session
    // stale-role serving becomes possible.
    return null;
  }
  return `session:${session.sub}:${session.iat}`;
}