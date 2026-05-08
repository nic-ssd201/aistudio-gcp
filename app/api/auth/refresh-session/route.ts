import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { getUserByCognitoSub } from "@/lib/db/drizzle"

/**
 * Check if session needs refresh
 *
 * Compares the JWT's `roleVersion` claim (set at sign-in and propagated through
 * the session callback) against the live value in the database.  Returns
 * `{ needsRefresh: true }` when they differ so the client can force a sign-in.
 *
 * **Polling-cache bypass** — this handler deliberately uses `getServerSession()`
 * (which decodes the NextAuth JWT directly) and queries the DB for `roleVersion`
 * without going through `authenticatePollingRequest()`.  That means:
 * - `getServerSession()` always reads the live JWT — not the polling cache.
 * - The `getUserByCognitoSub()` call always hits the database — it is not
 *   affected by the 5-minute in-process polling-session cache.
 * - The `roleVersion` comparison (`dbRoleVersion !== sessionRoleVersion`) is
 *   therefore always fresh, even on instances whose polling cache still holds
 *   the old roles for up to 5 minutes after a role change.
 *
 * This property is load-bearing: it is what makes the polling-session-cache
 * role-revocation strategy work on multi-instance deployments.  Do NOT switch
 * this handler to `authenticatePollingRequest()` without also adding explicit
 * cache-bypass logic for the `roleVersion` comparison.
 *
 * **POST handler removed** — the former POST handler cleared `authjs.session-token`
 * but in production NextAuth v5 sets `__Secure-authjs.session-token` (RFC 6265bis
 * `__Secure-` prefix), so the expire-cookie response was silently leaving the real
 * session cookie intact.  No production client calls POST to this endpoint
 * (`grep -rn '/api/auth/refresh-session'` finds only doc references); the active
 * flow is the GET role-version compare below + the NextAuth `/api/auth/signout`
 * route for actual sign-out.  The dead POST handler is removed to prevent future
 * callers from discovering a broken sign-out path.
 */
export async function GET() {
  const requestId = generateRequestId()
  const timer = startTimer("api.auth.check-session")
  const log = createLogger({ requestId, route: "api.auth.check-session" })

  log.info("GET /api/auth/refresh-session - Checking if session needs refresh")

  try {
    const session = await getServerSession()

    if (!session) {
      log.warn("No session found")
      timer({ status: "error", reason: "no_session" })
      return NextResponse.json(
        {
          isSuccess: false,
          needsRefresh: false,
          message: "No active session"
        },
        { status: 200, headers: { "X-Request-Id": requestId } }
      )
    }

    // Check role_version from database and compare with session
    try {
      // Get the user's current role version from the database
      const user = await getUserByCognitoSub(session.sub)

      if (!user) {
        log.warn("User not found in database", { sub: session.sub })
        timer({ status: "error", reason: "user_not_found" })
        return NextResponse.json(
          {
            isSuccess: false,
            needsRefresh: false,
            message: "User not found"
          },
          { status: 404, headers: { "X-Request-Id": requestId } }
        )
      }

      const dbRoleVersion = user.roleVersion || 0
      // UserSession already declares roleVersion?: number — no cast needed.
      // Use typeof (same pattern as server-session.ts:88) rather than ||, so
      // roleVersion: 0 is treated as present (version 0) rather than falling
      // back to the default.  || would silently treat a valid 0 as "absent"
      // and return 0 anyway, but the intent is clearer with typeof.
      const sessionRoleVersion = typeof session.roleVersion === 'number' ? session.roleVersion : 0

      log.debug("Role version comparison", {
        userId: session.sub,
        dbRoleVersion,
        sessionRoleVersion
      })

      const needsRefresh = dbRoleVersion !== sessionRoleVersion

      if (needsRefresh) {
        log.info("Session needs refresh due to role version mismatch", {
          userId: session.sub,
          dbRoleVersion,
          sessionRoleVersion
        })
      }

      timer({ status: "success", needsRefresh })
      return NextResponse.json(
        {
          isSuccess: true,
          needsRefresh,
          message: needsRefresh
            ? "Your permissions have changed. Please sign in again to apply the updates."
            : "Session is up to date"
        },
        { headers: { "X-Request-Id": requestId } }
      )
    } catch (dbError) {
      log.error("Error checking role version", {
        error: dbError instanceof Error ? dbError.message : "Unknown error"
      })

      // If we can't check, assume no refresh needed to avoid disrupting the user
      timer({ status: "error", reason: "db_error" })
      return NextResponse.json(
        {
          isSuccess: true,
          needsRefresh: false,
          message: "Session is up to date"
        },
        { headers: { "X-Request-Id": requestId } }
      )
    }

  } catch (error) {
    timer({ status: "error" })
    log.error("Error checking session", {
      error: error instanceof Error ? error.message : "Unknown error"
    })

    return NextResponse.json(
      {
        isSuccess: false,
        needsRefresh: false,
        message: "Failed to check session status"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}
