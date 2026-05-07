/**
 * High-performance session cache for polling operations
 * Eliminates redundant auth checks during long-running operations
 */

import { createLogger } from '@/lib/logger';
import type { UserSession } from '@/lib/auth/server-session';

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
  getCachedSession(sessionId: string): CachedSession | null {
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

    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.options.maxEntries) {
      this.evictOldest();
    }

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
    const legacyKey = `session:${sub}`; // pre-iat format — belt-and-braces
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
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    // Use !== null rather than truthiness so an empty-string key (unlikely but
    // theoretically possible) is not skipped.
    if (oldestKey !== null) {
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
    const avgEntrySize = 500; // Estimated bytes per cache entry
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

// Singleton instance for application-wide use
export const pollingSessionCache = new PollingSessionCache({
  maxAge: 5 * 60 * 1000, // 5 minutes - longer than typical polling sessions
  maxEntries: 500, // Reasonable for concurrent users
  cleanupInterval: 2 * 60 * 1000, // 2 minutes
});

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