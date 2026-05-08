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


/**
 * Gets the current authenticated session using NextAuth v5.
 * Returns null when the user is not signed in or the session has expired.
 */
export async function getServerSession(): Promise<UserSession | null> {
  const context = await createRequestContext();

  try {
    const { auth } = createAuth();
    const session = await auth();

    if (!session?.user?.id) {
      return null;
    }

    // Explicit projection — no spread — so only declared UserSession fields are
    // returned.  Extra NextAuth fields on session.user (e.g. `name`, `image`)
    // are intentionally excluded; callers should not depend on undeclared keys.
    return {
      sub: session.user.id,
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
