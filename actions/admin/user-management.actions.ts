"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { getServerSession } from "@/lib/auth/server-session"
import { requireRole } from "@/lib/auth/role-helpers"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { eq, sql, desc, count, inArray, ilike, or, and, type SQL } from "drizzle-orm"
import { users, userRoles, roles } from "@/lib/db/schema"
import { nexusConversations } from "@/lib/db/schema/tables/nexus-conversations"
import { promptUsageEvents } from "@/lib/db/schema/tables/prompt-usage-events"
import { getDateThreshold } from "@/lib/date-utils"
import { pollingSessionCache } from "@/lib/auth/polling-session-cache"

// Constants
const ACTIVE_USER_THRESHOLD_DAYS = 30 // Users who signed in within this many days are considered "active"

// Types
export interface UserStats {
  totalUsers: number
  activeNow: number
  pendingInvites: number
  admins: number
  trends?: {
    totalUsers?: number
    activeNow?: number
    pendingInvites?: number
    admins?: number
  }
}

export interface UserListItem {
  id: number
  firstName: string
  lastName: string
  email: string
  roles: string[]
  status: "active" | "inactive" | "pending"
  lastSignInAt: string | null
  createdAt: string | null
}

export interface UserActivity {
  nexusConversations: number
  promptsUsed: number
  lastActivity: string | null
}

export interface UserFilters {
  search?: string
  status?: "all" | "active" | "inactive" | "pending"
  role?: string
}

// Helper to determine user status based on activity
function getUserStatus(lastSignInAt: Date | null): "active" | "inactive" | "pending" {
  if (!lastSignInAt) {
    return "pending" // Never signed in
  }

  const thresholdDate = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)

  if (lastSignInAt >= thresholdDate) {
    return "active"
  }

  return "inactive"
}

/**
 * Get user management statistics for the dashboard
 */
export async function getUserStats(): Promise<ActionState<UserStats>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserStats")
  const log = createLogger({ requestId, action: "getUserStats" })

  try {
    log.info("Fetching user stats")

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Calculate threshold for active users
    const thirtyDaysAgo = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)

    // Parallelize all stat queries for better performance
    const [totalResult, activeResult, pendingResult, adminResult] = await Promise.all([
      // Get total users count
      executeQuery(
        (db) => db.select({ count: count() }).from(users),
        "getUserStats-total"
      ),
      // Get active users (signed in within last 30 days)
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(users)
            .where(sql`${users.lastSignInAt} >= ${thirtyDaysAgo}`),
        "getUserStats-active"
      ),
      // Get pending users (never signed in)
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(users)
            .where(sql`${users.lastSignInAt} IS NULL`),
        "getUserStats-pending"
      ),
      // Get admin count
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(eq(roles.name, "administrator")),
        "getUserStats-admins"
      ),
    ])

    const totalUsers = totalResult[0]?.count ?? 0
    const activeNow = activeResult[0]?.count ?? 0
    const pendingInvites = pendingResult[0]?.count ?? 0
    const admins = adminResult[0]?.count ?? 0

    timer({ status: "success" })
    log.info("User stats fetched", { totalUsers, activeNow, pendingInvites, admins })

    return createSuccess(
      { totalUsers, activeNow, pendingInvites, admins },
      "Stats fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch user stats", {
      context: "getUserStats",
      requestId,
      operation: "getUserStats",
    })
  }
}

/**
 * Get list of users with filtering support
 */
export async function getUsers(
  filters?: UserFilters
): Promise<ActionState<UserListItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUsers")
  const log = createLogger({ requestId, action: "getUsers" })

  try {
    log.info("Fetching users", { filters: sanitizeForLogging(filters) })

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Build dynamic WHERE conditions for database-level filtering
    const conditions: SQL[] = []

    // Search filter - case-insensitive search across firstName, lastName, email
    if (filters?.search) {
      // Validate search input (prevent DoS with excessively long strings)
      const searchInput = filters.search.trim()

      // Skip query if empty string after trim (performance optimization)
      if (searchInput.length === 0) {
        // Don't add search condition, effectively showing all users
      } else if (searchInput.length > 100) {
        throw ErrorFactories.invalidInput(
          "search",
          searchInput,
          "Must be 100 characters or less"
        )
      } else {
        // Escape ILIKE wildcard characters to prevent unintended matching
        // User searching for "%" should not match all records
        const escapedInput = searchInput
          .replace(/\\/g, "\\\\") // Escape backslashes first
          .replace(/%/g, "\\%")   // Escape % wildcard
          .replace(/_/g, "\\_")   // Escape _ wildcard

        const searchTerm = `%${escapedInput}%`

        // Use Drizzle's ilike() for type safety instead of raw SQL
        conditions.push(
          or(
            ilike(users.firstName, searchTerm),
            ilike(users.lastName, searchTerm),
            ilike(users.email, searchTerm)
          )!
        )
      }
    }

    // Status filter - based on lastSignInAt
    if (filters?.status && filters.status !== "all") {
      // Runtime validation - TypeScript type doesn't enforce this at runtime
      const VALID_STATUSES = ["all", "active", "inactive", "pending"] as const
      if (!VALID_STATUSES.includes(filters.status)) {
        throw ErrorFactories.invalidInput(
          "status",
          filters.status,
          `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`
        )
      }

      if (filters.status === "pending") {
        conditions.push(sql`${users.lastSignInAt} IS NULL`)
      } else if (filters.status === "active") {
        const threshold = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)
        conditions.push(sql`${users.lastSignInAt} >= ${threshold}`)
      } else if (filters.status === "inactive") {
        const threshold = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)
        conditions.push(
          sql`${users.lastSignInAt} IS NOT NULL AND ${users.lastSignInAt} < ${threshold}`
        )
      }
    }

    // Get filtered users (without role filtering - that's done on the role query)
    const usersResult = await executeQuery(
      (db) => {
        const baseSelect = {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          lastSignInAt: users.lastSignInAt,
          createdAt: users.createdAt,
        }

        // Build WHERE clause for search/status filters only
        const whereClause = conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined

        // Fetch users with search/status filters (role filtering done in role query)
        const query = db.select(baseSelect).from(users)

        return whereClause
          ? query.where(whereClause).orderBy(desc(users.createdAt))
          : query.orderBy(desc(users.createdAt))
      },
      "getUsers-list"
    )

    // Get user IDs for role query
    const userIds = usersResult.map((u) => u.id)

    if (userIds.length === 0) {
      timer({ status: "success" })
      log.info("No users found matching filters")
      return createSuccess([], "Users fetched successfully")
    }

    // Get roles for filtered users only
    const allUserRoles = await executeQuery(
      (db) =>
        db
          .select({
            userId: userRoles.userId,
            roleName: roles.name,
          })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(inArray(userRoles.userId, userIds)),
      "getUsers-roles"
    )

    // Build role map
    const roleMap = new Map<number, string[]>()
    for (const ur of allUserRoles) {
      if (ur.userId) {
        const existing = roleMap.get(ur.userId) || []
        existing.push(ur.roleName)
        roleMap.set(ur.userId, existing)
      }
    }

    // Transform results and apply role filtering if needed
    let userList: UserListItem[] = usersResult.map((user) => ({
      id: user.id,
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      email: user.email || "",
      roles: roleMap.get(user.id) || [],
      status: getUserStatus(user.lastSignInAt),
      lastSignInAt: user.lastSignInAt?.toISOString() || null,
      createdAt: user.createdAt?.toISOString() || null,
    }))

    // Filter by role if specified (done in-memory after fetching all roles once)
    if (filters?.role && filters.role !== "all") {
      userList = userList.filter((user) => user.roles.includes(filters.role!))
    }

    timer({ status: "success" })
    log.info("Users fetched", { count: userList.length })

    return createSuccess(userList, "Users fetched successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch users", {
      context: "getUsers",
      requestId,
      operation: "getUsers",
    })
  }
}

/**
 * Get available roles for filtering and assignment
 */
export async function getRoles(): Promise<
  ActionState<Array<{ id: string; name: string }>>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getRoles")
  const log = createLogger({ requestId, action: "getRoles" })

  try {
    log.info("Fetching roles")

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    const roleList = await executeQuery(
      (db) =>
        db
          .select({
            id: roles.id,
            name: roles.name,
          })
          .from(roles)
          .orderBy(roles.name),
      "getRoles"
    )

    timer({ status: "success" })
    log.info("Roles fetched", { count: roleList.length })

    return createSuccess(
      roleList.map((r) => ({ id: String(r.id), name: r.name })),
      "Roles fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch roles", {
      context: "getRoles",
      requestId,
      operation: "getRoles",
    })
  }
}

/**
 * Get user activity summary for the detail view
 */
export async function getUserActivity(
  userId: number
): Promise<ActionState<UserActivity>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserActivity")
  const log = createLogger({ requestId, action: "getUserActivity" })

  try {
    log.info("Fetching user activity", { userId })

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Check if user exists
    const userExists = await executeQuery(
      (db) => db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
      "getUserActivity-checkUser"
    )

    if (userExists.length === 0) {
      throw ErrorFactories.dbRecordNotFound("users", userId)
    }

    // Parallelize activity queries for better performance
    const [conversationsResult, promptsResult, lastConversation] = await Promise.all([
      // Get nexus conversation count
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .where(eq(nexusConversations.userId, userId)),
        "getUserActivity-conversations"
      ),
      // Get prompt usage count
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(promptUsageEvents)
            .where(eq(promptUsageEvents.userId, userId)),
        "getUserActivity-prompts"
      ),
      // Get last activity (most recent conversation)
      executeQuery(
        (db) =>
          db
            .select({ lastMessageAt: nexusConversations.lastMessageAt })
            .from(nexusConversations)
            .where(eq(nexusConversations.userId, userId))
            .orderBy(desc(nexusConversations.lastMessageAt))
            .limit(1),
        "getUserActivity-lastActivity"
      ),
    ])

    const nexusConversationsCount = conversationsResult[0]?.count ?? 0
    const promptsUsed = promptsResult[0]?.count ?? 0
    const lastActivity = lastConversation[0]?.lastMessageAt?.toISOString() || null

    timer({ status: "success" })
    log.info("User activity fetched", {
      userId,
      nexusConversationsCount,
      promptsUsed,
    })

    return createSuccess(
      {
        nexusConversations: nexusConversationsCount,
        promptsUsed,
        lastActivity,
      },
      "Activity fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch user activity", {
      context: "getUserActivity",
      requestId,
      operation: "getUserActivity",
    })
  }
}

/**
 * Update user information (name and roles)
 */
export async function updateUser(
  userId: number,
  data: {
    firstName: string
    lastName: string
    roles: string[]
  }
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateUser")
  const log = createLogger({ requestId, action: "updateUser" })

  try {
    log.info("Updating user", { userId, data: sanitizeForLogging(data) })

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Validate input
    if (!data.firstName?.trim()) {
      throw ErrorFactories.missingRequiredField("firstName")
    }

    if (!data.lastName?.trim()) {
      throw ErrorFactories.missingRequiredField("lastName")
    }

    if (!data.roles || data.roles.length === 0) {
      throw ErrorFactories.missingRequiredField("roles")
    }

    // Update user and role assignments in a transaction.
    // All validation happens inside the transaction to prevent race conditions.
    // The transaction returns { sub, rolesChanged } so both values are available
    // as consts post-commit — no mutable outer variables that could be silently
    // clobbered by a concurrent call on the same event-loop tick.
    const txResult = await executeTransaction(
      async (tx) => {
        // ── 1. Fetch current role assignments ────────────────────────────────
        // Done first so we can (a) diff against incoming roles before the UPDATE
        // and (b) reuse the result for the admin-removal guard below without a
        // second round-trip.
        const currentUserRoles = await tx
          .select({ roleName: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(eq(userRoles.userId, userId))

        const currentRoleNames = new Set(currentUserRoles.map((r) => r.roleName))
        const incomingRoleNames = new Set(data.roles)
        // A role diff exists when the sets differ in size OR any incoming name
        // is absent from the current set.  Symmetric: if sizes match and all
        // incoming names are present, the sets are identical.
        const rolesChanged =
          currentRoleNames.size !== incomingRoleNames.size ||
          [...incomingRoleNames].some((name) => !currentRoleNames.has(name))

        // ── 2. Update user basic info ────────────────────────────────────────
        // Include cognitoSub in .returning() so it is available post-commit for
        // pollingSessionCache.invalidateUser() without an additional DB query.
        //
        // roleVersion is bumped only when roles actually changed.  An unnecessary
        // bump on a name-only edit triggers /api/auth/refresh-session fleet-wide
        // (every instance whose JWT carries an older roleVersion will force re-auth
        // for that user) — disruptive for a purely cosmetic change.
        //
        // Safety: other code paths that mutate roles without going through updateUser
        // (e.g. lib/db/user-roles.ts assignRole / removeRole / replaceRoles) bump
        // roleVersion themselves inside their own transactions, so skipping the bump
        // here on a name-only edit does not create a gap — roles aren't changing.
        const result = await tx
          .update(users)
          .set({
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
            // Conditional bump: only when roles actually differ.
            // Without this bump on role changes, the multi-instance stale-role
            // fallback (/api/auth/refresh-session) never fires — the in-process
            // pollingSessionCache.invalidateUser() only flushes the local cache.
            ...(rolesChanged ? { roleVersion: sql`${users.roleVersion} + 1` } : {}),
          })
          .where(eq(users.id, userId))
          // TODO(#8): rename users.cognitoSub → users.authSub once the column rename lands
          .returning({ id: users.id, cognitoSub: users.cognitoSub })

        // Throw if user doesn't exist
        if (result.length === 0) {
          throw ErrorFactories.dbRecordNotFound("users", userId)
        }

        const capturedSub = result[0].cognitoSub ?? null;

        // ── 3. Validate incoming role names ──────────────────────────────────
        // Get role IDs from role names (inside transaction to prevent race condition)
        const roleList = await tx
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(inArray(roles.name, data.roles))

        if (roleList.length !== data.roles.length) {
          throw ErrorFactories.invalidInput(
            "roles",
            data.roles,
            "One or more role names are invalid"
          )
        }

        // ── 4. Admin-removal guard ───────────────────────────────────────────
        // Prevent removing admin role from last administrator (would lock everyone out).
        // Reuse currentUserRoles fetched in step 1 — no extra query needed.
        const isRemovingAdmin = !data.roles.includes("administrator")
        if (isRemovingAdmin) {
          const isCurrentlyAdmin = currentUserRoles.some((r) => r.roleName === "administrator")

          if (isCurrentlyAdmin) {
            // User is currently an admin and we're removing it - check if they're the last one
            const adminCountResult = await tx
              .select({ count: count() })
              .from(userRoles)
              .innerJoin(roles, eq(userRoles.roleId, roles.id))
              .where(eq(roles.name, "administrator"))

            const adminCount = adminCountResult[0]?.count ?? 0
            if (adminCount <= 1) {
              throw ErrorFactories.bizInvalidState(
                "updateUser",
                "last administrator role removal attempted",
                "Cannot remove administrator role from the last administrator"
              )
            }
          }
        }

        // ── 5. Replace role assignments ──────────────────────────────────────
        // Delete existing role assignments
        await tx.delete(userRoles).where(eq(userRoles.userId, userId))

        // Insert new role assignments
        await tx.insert(userRoles).values(
          roleList.map((role) => ({
            userId,
            roleId: role.id,
          }))
        )

        // Return both sub and rolesChanged so the post-commit cache-flush can be
        // gated on actual role changes — a name-only edit should not evict the
        // cache, symmetric with the conditional roleVersion bump above.
        // Returning as a const object avoids a closed-over mutable variable that
        // could be clobbered if two requests for the same user overlap on the same
        // event-loop tick.
        return { sub: capturedSub, rolesChanged }
      },
      "updateUser-transaction"
    )

    const { sub: subFromTx, rolesChanged: didRolesChange } = txResult

    // Flush polling cache only when roles actually changed, to mirror the
    // conditional roleVersion bump above.  A name-only edit does not alter
    // the user's role set — evicting the cache would serve no purpose and
    // wastes one TTL worth of warm cache for a cosmetic operation.
    // subFromTx is captured inside the transaction and returned as the tx
    // result; no extra post-commit DB query is needed and a post-commit
    // failure cannot mask a successful commit.
    // NOTE: only the current process's in-process cache is flushed. On Cloud Run
    // (or any multi-instance deployment), the other N-1 instances continue serving
    // stale roles for up to 5 minutes (the TTL).  This is the accepted trade-off
    // for the polling-auth perf improvement; a cross-instance signal (Pub/Sub,
    // Redis invalidation) would eliminate the window but is out of scope here.
    if (subFromTx && didRolesChange) {
      // Wrap in try/catch: cache invalidation is best-effort. invalidateUser()
      // is currently synchronous Map iteration with no realistic throw path,
      // but the try/catch future-proofs for any async or more complex extension
      // of the cache module. If it does throw, we log a warning rather than
      // turning a successful committed role change into an apparent failure.
      try {
        pollingSessionCache.invalidateUser(subFromTx)
        log.info("Polling cache flushed after role update", { userId })
      } catch (cacheErr) {
        log.warn("Polling cache flush failed after role update (non-fatal)", {
          userId,
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        })
      }
    }

    timer({ status: "success" })
    log.info("User updated successfully", { userId })

    return createSuccess(undefined, "User updated successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update user", {
      context: "updateUser",
      requestId,
      operation: "updateUser",
    })
  }
}

/**
 * Delete a user and all associated data
 */
export async function deleteUser(userId: number): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteUser")
  const log = createLogger({ requestId, action: "deleteUser" })

  try {
    log.info("Deleting user", { userId })

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Get session to check for self-deletion (session.user.id needed)
    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    // Prevent self-deletion.
    // session.sub is the Google OIDC sub (a string); userId is a numeric DB row
    // ID. Comparing them directly (`session.user.id === userId`) is always false
    // because string !== number — the guard was silently broken.
    // Fix: resolve sub → numeric DB ID first, then compare.
    //
    // A null result (admin's own record missing) is treated as a hard block,
    // not a pass-through.  Allowing the delete when null would mean a
    // DB-connectivity blip or a JIT failure silently disables the self-deletion
    // guard — a safer posture is fail-closed: block and log, forcing an operator
    // to investigate rather than allowing a potentially self-destructive action.
    const currentAdminDbId = await getUserIdByCognitoSubAsNumber(session.sub)
    if (currentAdminDbId === null) {
      log.error("deleteUser: could not resolve admin sub to DB id — blocking delete as fail-closed", {
        adminSub: session.sub,
        targetUserId: userId,
      })
      throw ErrorFactories.bizInvalidState(
        "deleteUser",
        "admin record not found",
        "Unable to verify identity — please try again or contact support"
      )
    }
    if (currentAdminDbId === userId) {
      throw ErrorFactories.bizInvalidState(
        "deleteUser",
        "self-deletion attempted",
        "cannot delete own account"
      )
    }

    // Delete user and role assignments in a transaction.
    // Admin check inside transaction prevents TOCTOU race condition.
    // cognitoSub is returned from the transaction body (not closed over) so the
    // binding is a const and there is no mutable outer variable that could be
    // silently clobbered by a concurrent call on the same event-loop tick.
    const subFromTx = await executeTransaction(
      async (tx) => {
        // Check if user being deleted is an admin (inside transaction to prevent race)
        const userToDelete = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(userRoles, eq(userRoles.userId, users.id))
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(and(eq(users.id, userId), eq(roles.name, "administrator")))

        if (userToDelete.length > 0) {
          // User is an admin - check if they're the last one
          const adminCountResult = await tx
            .select({ count: count() })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(eq(roles.name, "administrator"))

          const adminCount = adminCountResult[0]?.count ?? 0
          if (adminCount <= 1) {
            throw ErrorFactories.bizInvalidState(
              "deleteUser",
              "last administrator deletion attempted",
              "Cannot delete the last administrator"
            )
          }
        }

        // Delete user role assignments first (foreign key constraint)
        await tx.delete(userRoles).where(eq(userRoles.userId, userId))

        // Delete the user and capture cognitoSub for post-commit cache flush.
        // .returning() includes cognitoSub so no extra round-trip is needed.
        const result = await tx
          .delete(users)
          .where(eq(users.id, userId))
          // TODO(#8): rename users.cognitoSub → users.authSub once the column rename lands
          .returning({ id: users.id, cognitoSub: users.cognitoSub })

        if (result.length === 0) {
          throw ErrorFactories.dbRecordNotFound("users", userId)
        }

        // Return cognitoSub so it is available as a const post-commit (see updateUser).
        return result[0].cognitoSub ?? null
      },
      "deleteUser-transaction"
    )

    // Flush the polling cache so the deleted user's cached session cannot be
    // used by polling endpoints until the 5-minute TTL expires naturally.
    // Symmetric with updateUser — only the current instance is flushed; see
    // pollingSessionCache.invalidateUser JSDoc for multi-instance trade-off.
    if (subFromTx) {
      // Best-effort: wrap in try/catch so a cache-module exception does not
      // surface as "Failed to delete user" for a commit that already succeeded.
      try {
        pollingSessionCache.invalidateUser(subFromTx)
        log.info("Polling cache flushed after user deletion", { userId })
      } catch (cacheErr) {
        log.warn("Polling cache flush failed after user deletion (non-fatal)", {
          userId,
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        })
      }
    }

    timer({ status: "success" })
    log.info("User deleted successfully", { userId })

    return createSuccess(undefined, "User deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete user", {
      context: "deleteUser",
      requestId,
      operation: "deleteUser",
    })
  }
}
