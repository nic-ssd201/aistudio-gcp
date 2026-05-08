"use server"

import { createAuth } from "@/auth";
import logger from "@/lib/logger";
import { createRequestContext } from "./request-context";

/**
 * Authenticated user session shape returned by getServerSession().
 * Populated from the Google OIDC JWT — sub is the Google account's unique ID.
 */
export interface UserSession {
  sub: string;
  email?: string;
  givenName?: string | null;
  familyName?: string | null;
  /** Google ID token — available in session (used for downstream API auth). */
  idToken?: string;
  /**
   * JWT issued-at timestamp (seconds since epoch). Copied from the NextAuth JWT
   * into the session so the polling session cache can key on `sub + iat` and
   * automatically bypass a stale entry when the user re-authenticates within the
   * 5-minute TTL window (a fresh login produces a new `iat`).
   */
  iat?: number;
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
  /**
   * Forward-compat index signature: `getServerSession` spreads `session.user`
   * (which may carry extra NextAuth fields such as `name` or `image`) into the
   * returned object. Without this signature TypeScript rejects the object literal
   * because the spread introduces keys not declared above. If you remove it,
   * explicitly project only the fields you need instead of spreading session.user.
   */
  [key: string]: unknown;
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

    return {
      ...session.user,
      sub: session.user.id,
      email: session.user.email || undefined,
      givenName: session.user.givenName || undefined,
      familyName: session.user.familyName || undefined,
      idToken: session.idToken || undefined,
      iat: typeof session.iat === 'number' ? session.iat : undefined,
      // roleVersion must be explicitly projected — session.user spread above
      // does not include it (roleVersion lives on the session root, not on
      // session.user).  Without this, refresh-session/route.ts always sees
      // sessionRoleVersion=0 and fires needsRefresh=true on every poll the
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
