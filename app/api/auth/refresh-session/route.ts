import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { getUserByCognitoSub } from "@/lib/db/drizzle"

/**
 * Force session refresh API
 * 
 * This endpoint can be called to force a session refresh,
 * typically after user roles have been changed.
 * It will invalidate the current JWT and force re-authentication.
 */
export async function POST() {
  const requestId = generateRequestId()
  const timer = startTimer("api.auth.refresh-session")
  const log = createLogger({ requestId, route: "api.auth.refresh-session" })
  
  log.info("POST /api/auth/refresh-session - Session refresh requested")
  
  try {
    const session = await getServerSession()
    
    if (!session) {
      log.warn("No session to refresh")
      timer({ status: "error", reason: "no_session" })
      return NextResponse.json(
        { isSuccess: false, message: "No active session" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }
    
    log.info("Session refresh initiated", { userId: session.sub })
    
    // Clear the session cookie to force re-authentication
    const response = NextResponse.json(
      { 
        isSuccess: true, 
        message: "Session refresh initiated. Please sign in again.",
        redirectUrl: "/auth/signin"
      },
      { headers: { "X-Request-Id": requestId } }
    )
    
    // Clear auth cookies
    response.cookies.set('authjs.session-token', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0 // Expire immediately
    })
    
    response.cookies.set('authjs.csrf-token', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0
    })
    
    response.cookies.set('authjs.callback-url', '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0
    })
    
    timer({ status: "success" })
    log.info("Session cookies cleared, user must re-authenticate")
    
    return response
    
  } catch (error) {
    timer({ status: "error" })
    log.error("Error refreshing session", {
      error: error instanceof Error ? error.message : "Unknown error"
    })
    
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: "Failed to refresh session"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

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
      const sessionRoleVersion = (session as { roleVersion?: number }).roleVersion || 0
      
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