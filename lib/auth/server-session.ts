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
      iat: session.iat || undefined,
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
