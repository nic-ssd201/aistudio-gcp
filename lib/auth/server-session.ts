"use server"

import { createAuth } from "@/auth";
import logger from "@/lib/logger";
import { createRequestContext } from "./request-context";

/**
 * Authenticated user session shape returned by getServerSession().
 * Populated from the Google OIDC JWT — sub is the Google account's unique ID.
 *
 * Only fields explicitly listed here are projected from the NextAuth session;
 * extra fields NextAuth may place on session.user (e.g. `name`, `image`) are
 * intentionally excluded so callers cannot read keys with no documented
 * contract.
 */
export interface UserSession {
  sub: string;
  email?: string;
  givenName?: string | null;
  familyName?: string | null;
  /** Google ID token — available in session (used for downstream API auth). */
  idToken?: string;
  /**
   * Login-time issued-at timestamp (seconds since epoch). Copied from token.loginIat
   * (the stable custom JWT claim) into the session so the polling session cache can
   * key on `sub + loginIat` and automatically bypass a stale entry when the user
   * re-authenticates within the 5-minute TTL window (a fresh login produces a new
   * loginIat; NextAuth's own `iat` is unsuitable because jose.EncryptJWT resets it
   * on every re-encode).
   *
   * Intentionally optional — may be absent on stale cookies that predate the loginIat
   * field (rolling deploy window) or on the fallback id_token-parse path.
   */
  loginIat?: number;
  /**
   * Role version monotonically incremented in the DB on every role change.
   * Propagated from the JWT through the session callback so
   * `/api/auth/refresh-session` can compare sessionRoleVersion against the DB
   * value and force re-auth only when roles have actually changed (rather than
   * on every poll once dbRoleVersion >= 1).  Without this field the comparison
   * always sees `undefined → 0` on the session side, triggering needsRefresh=true
   * on every request for every user whose roles have ever been updated.
   */
  roleVersion?: number;
}

// ── Test reset helper ─────────────────────────────────────────────────────────
/**
 * Reset the lazy _serverAuth singleton so the next call to getServerSession()
 * re-runs createAuth().
 *
 * @internal — tests ONLY.  Call this when a test mutates process.env between
 * cases and needs the next getServerSession() call to pick up new credentials
 * rather than re-using the previously-initialized instance.
 *
 * Note: jest.mock('@/auth') is babel-hoisted and replaces createAuth() globally,
 * so most tests don't need this.  Only required for tests that control env vars
 * without replacing the module (e.g. process.env.AUTH_GOOGLE_ID mutation in an
 * isolateModules() block that does NOT mock '@/auth').
 */
export function resetServerAuthForTests(): void {
  _serverAuth = null;
}

// ── Lazy singleton ─────────────────────────────────────────────────────────
// Lazy singleton — initialized on first call to getServerAuth() rather than at
// module load.  This ensures that importing server-session.ts never throws, even
// when AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are absent (e.g. a misconfigured Cloud
// Run revision that should still respond to health probes before auth is needed).
//
// Without lazy init, any module that transitively imports server-session.ts
// (most of app/) would explode on first import — Next.js would fail to boot,
// defeating instrumentation.ts's startup-tolerance intent.
//
// The credential guard (assertGoogleCreds) still fires on the first call to
// getServerSession(), so an unconfigured instance fails loudly the moment a
// request actually requires auth — not silently.
//
// Thread-safety: Node.js is single-threaded. There is no race between two
// concurrent calls both seeing _serverAuth === null and both calling createAuth()
// before the assignment — one call runs to completion before the other starts.
//
// jest.mock('@/auth') is babel-hoisted above any module-level code, so tests
// that mock createAuth() will see their mock here — the credential guard
// inside createAuth() never fires against real env vars during unit tests.
let _serverAuth: ReturnType<typeof createAuth>['auth'] | null = null;

function getServerAuth(): ReturnType<typeof createAuth>['auth'] {
  if (!_serverAuth) {
    _serverAuth = createAuth().auth;
  }
  return _serverAuth;
}

/**
 * Gets the current authenticated session using NextAuth v5.
 * Returns null when the user is not signed in or the session has expired.
 */
export async function getServerSession(): Promise<UserSession | null> {
  const context = await createRequestContext();

  try {
    const session = await getServerAuth()();

    if (!session?.user?.id) {
      return null;
    }

    // TypeScript narrows session.user.id to `string` after the early return above
    // (the optional-chain guard `!session?.user?.id` ensures it is truthy).
    // `UserSession.sub` is typed as `string` (not optional) so callers of
    // getServerSession() can treat sub as non-empty without a secondary guard.
    const userId = session.user.id; // string — narrowed by the !id guard above

    // Explicit projection — no spread — so only declared UserSession fields are
    // returned.  Extra NextAuth fields on session.user (e.g. `name`, `image`)
    // are intentionally excluded; callers should not depend on undeclared keys.
    return {
      sub: userId,
      email: session.user.email || undefined,
      givenName: session.user.givenName || undefined,
      familyName: session.user.familyName || undefined,
      idToken: session.idToken || undefined,
      // `session.loginIat` is set from `token.loginIat` by the session callback in
      // auth.ts.  When loginIat is absent (stale pre-deploy cookie), auth.ts uses
      // `delete session.loginIat` (not assignment of undefined) to avoid type
      // narrowing issues — hence the explicit typeof guard here rather than `??`.
      loginIat: typeof session.loginIat === 'number' ? session.loginIat : undefined,
      // roleVersion lives on the session root, not on session.user — must be
      // explicitly projected here.  Without this, refresh-session/route.ts always
      // sees sessionRoleVersion=0 and fires needsRefresh=true on every poll the
      // moment dbRoleVersion reaches 1 after any role change.
      roleVersion: typeof session.roleVersion === 'number' ? session.roleVersion : undefined,
    };
  } catch (error) {
    logger.error("Session retrieval failed:", {
      error: {
        message: error instanceof Error ? error.message : "Unknown error",
        name: error instanceof Error ? error.name : "Error",
      },
      requestId: context.requestId,
    });
    return null;
  }
}
