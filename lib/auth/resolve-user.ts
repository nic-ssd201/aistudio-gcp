/**
 * Resolve a user session to a database user ID.
 *
 * Performs JIT (just-in-time) user provisioning if the user
 * doesn't exist in the database yet. This handles the case where
 * a valid Google OIDC session has no corresponding users table record
 * (e.g., first login, deleted user re-authenticating).
 *
 * @see actions/db/get-current-user-action.ts for the full provisioning
 *      flow (role assignment, name updates, last sign-in tracking).
 *      This utility performs a lightweight version — lookup + create only.
 */

import {
  getUserIdByCognitoSubAsNumber,
  getUserByEmail,
  updateUser,
  createUser,
  addUserRole,
} from "@/lib/db/drizzle"
import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { ErrorFactories } from "@/lib/error-utils"
import { ErrorCode } from "@/types/error-types"
import type { UserSession } from "./server-session"

/**
 * Resolve a user session to a numeric database user ID.
 *
 * Flow:
 * 1. Look up user by sub / cognito_sub column (fast path)
 * 2. If not found, look up by email and link sub (migration path)
 * 3. If still not found, create user via UPSERT and assign default role (new user path)
 *
 * **Write side-effect**: On the first call for a new user, this function
 * creates a users row and assigns a default role. Callers on read-only (GET) routes
 * accept this one-time write — it is intentional for JIT provisioning.
 *
 * @returns Numeric user ID (never null — provisions if missing)
 * @throws ErrorFactories.missingRequiredField if session has no email (new user only)
 * @throws If database operations fail
 */
export async function resolveUserId(
  session: UserSession,
  requestId?: string
): Promise<number> {
  const log = createLogger({ module: "resolveUserId", requestId })

  // Fast path: user exists (returns null on miss, throws TypeError on malformed ID)
  const existingId = await getUserIdByCognitoSubAsNumber(session.sub)
  if (existingId !== null) {
    return existingId
  }

  // Slow path: provision the user
  log.info("User not found by OIDC sub — provisioning", {
    // Note: the DB column is still named cognito_sub; rename tracked in
    // nic-ssd201/aistudio-gcp#8 (col rename cognito_sub → auth_sub).
    sub: sanitizeForLogging(session.sub),
    hasEmail: !!session.email,
  })

  // Check by email (migration path — link the OIDC sub to the existing record
  // rather than creating a duplicate row)
  if (session.email) {
    try {
      const byEmail = await getUserByEmail(session.email)
      if (byEmail) {
        log.info("User found by email, linking OIDC sub", {
          userId: byEmail.id,
        })
        // MUST explicitly update cognitoSub column — createUser UPSERT conflicts on
        // that column, not email. Without this call a duplicate row is inserted.
        // Column rename to auth_sub tracked in nic-ssd201/aistudio-gcp#8.
        // Mirrors getCurrentUserAction.ts:100
        await updateUser(byEmail.id, { cognitoSub: session.sub })
        return byEmail.id
      }
    } catch (error) {
      // getUserByEmail throws ErrorFactories.dbRecordNotFound when not found.
      // Check the typed error code — string-match is too broad and risks swallowing
      // real DB errors whose message happens to contain "not found".
      const isNotFound =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: unknown }).code === ErrorCode.DB_RECORD_NOT_FOUND
      if (!isNotFound) {
        throw error
      }
      // User not found by email — fall through to create
    }
  }

  // Require a real email for new users — synthetic addresses create permanent
  // bad data in the users table and break downstream notification delivery.
  if (!session.email) {
    log.warn("Cannot provision user: session has no email address", {
      sub: sanitizeForLogging(session.sub),
    })
    throw ErrorFactories.missingRequiredField("email")
  }

  // New user: create via UPSERT (safe for concurrent requests)
  // session.email is guaranteed non-null after the guard above
  const username = session.email.split("@")[0]
  const firstName = session.givenName || username || "User"
  const lastName = session.familyName || undefined

  const newUser = await createUser({
    cognitoSub: session.sub,
    email: session.email,
    firstName,
    lastName,
  })

  // Guard against UPSERT returning no rows (DB trigger, RLS, permission error)
  const userId = newUser?.id
  if (!userId || typeof userId !== "number" || userId <= 0) {
    throw ErrorFactories.dbQueryFailed(
      "createUser UPSERT",
      new Error(`Returned no valid ID for sub: ${sanitizeForLogging(session.sub)}`)
    )
  }

  // Assign default role using addUserRole, which runs in a transaction and
  // increments role_version for session cache invalidation.
  // Numeric username prefix → student (K-12 district convention: student IDs
  // are all-digit numbers, e.g. 123456@psd401.net). Non-numeric → staff.
  // Defaults to least-privilege (student) when username cannot be determined.
  const isNumeric = /^\d+$/.test(username) // already false for empty strings
  const defaultRole = isNumeric ? "student" : "staff"

  try {
    await addUserRole(userId, defaultRole)
    log.info("User provisioned with default role", {
      userId,
      role: defaultRole,
    })
  } catch (error) {
    // Role assignment failure is non-fatal — user can still access the app,
    // and getCurrentUserAction will handle role assignment on next full login.
    // Distinguish a missing role record (expected in misconfigured envs) from
    // infrastructure failures (DB connectivity, deadlock) which warrant error-level.
    const isRoleNotFound =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: unknown }).code === ErrorCode.DB_RECORD_NOT_FOUND
    if (isRoleNotFound) {
      log.warn("Default role not found in database — user provisioned without role", {
        userId,
        attemptedRole: defaultRole,
      })
    } else {
      log.error("Role assignment failed — infrastructure error; user provisioned without role", {
        userId,
        attemptedRole: defaultRole,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    }
  }

  return userId
}
