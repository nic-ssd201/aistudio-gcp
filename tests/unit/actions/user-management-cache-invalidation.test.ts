// @ts-nocheck — jest.doMock() factory types inside jest.isolateModules() are not
// inferrable by TypeScript; this is a test-only file so strict checking is relaxed.

/**
 * Regression pin: updateUser() must call pollingSessionCache.invalidateUser(sub)
 * after the role-change transaction commits.
 *
 * Without this wiring the polling cache would serve stale roles for up to 5 minutes
 * after an admin demotes or elevates a user — the cache invalidation is the only
 * mechanism that propagates role changes to polling endpoints before TTL expiry.
 *
 * The cognitoSub (Google OIDC `sub`) is captured inside the transaction via
 * `.returning({ id, cognitoSub })` rather than a post-commit query, eliminating
 * the risk of masking a successful commit as a failure when the extra query throws.
 *
 * Test strategy:
 *   Uses jest.isolateModules() so every dependency of updateUser() starts from a
 *   clean module registry.  This allows per-test control over executeTransaction
 *   and pollingSessionCache without interference from the global jest.setup.js mocks.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ── Constants ──────────────────────────────────────────────────────────────────
const STUB_SUB = 'google-oidc-sub-abc123'

/**
 * Build a Proxy-based `tx` for use inside the updateUser transaction callback.
 *
 * All Drizzle chain calls (select, from, where, innerJoin, etc.) return the
 * Proxy itself so chains compose freely.
 *
 * When `await`ed, the Proxy resolves to rows shaped to satisfy the three select
 * queries inside the updateUser transaction callback:
 *   - role lookup:  one `{ id, name }` row per requested role (length match)
 *   - admin-check:  roleName !== 'administrator' (isCurrentlyAdmin = false)
 *   - admin-count:  count = 2 (guards against last-admin removal pass)
 *
 * The first `.returning()` call yields the user-update row with cognitoSub.
 *
 * @param currentRoleNames - Roles to return for the FIRST select (the
 *   "fetch current role assignments" query).  Defaults to `roleNames` so
 *   tests that don't care about the diff still work.  Pass a different set
 *   to simulate a real role change (`rolesChanged = true`).
 */
// Sentinel markers for the schema mock — distinct objects so the Proxy can
// tell them apart via reference equality when `.from(table)` is intercepted.
// Named `_schemaName` rather than Symbol so JSON.stringify in logs still works.
const SCHEMA_SENTINELS = {
  users:     { _schemaName: 'users' },
  userRoles: { _schemaName: 'userRoles' },
  roles:     { _schemaName: 'roles' },
} as const

/**
 * Build a Proxy-based `tx` for use inside the updateUser transaction callback.
 *
 * The Proxy intercepts Drizzle's fluent API so the action under test can run
 * against an in-memory stub without a real database.
 *
 * ### Why table-keyed, not selectCallCount-keyed
 *
 * The previous version keyed SELECT responses on invocation order
 * (selectCallCount), which silently broke if any future edit reordered the
 * SQL queries inside the transaction.  This version intercepts `.from(table)`
 * and maps each schema-sentinel to a fixed response:
 *
 *   - `.from(SCHEMA_SENTINELS.userRoles)` → current role assignments
 *     (`currentRoleNames`); used by the "fetch current roles" and the
 *     "admin count" SELECTs.
 *   - `.from(SCHEMA_SENTINELS.roles)`     → role-name validation rows
 *     (`roleNames`).
 *   - anything else (e.g. `.from(users)`) → [].
 *
 * If the transaction's query order changes, the correct rows are still returned
 * because dispatch is keyed on what is queried, not when.
 *
 * @param currentRoleNames - Roles to return for `.from(userRoles)` SELECTs
 *   (the user's current assignments before the edit).  Defaults to `roleNames`
 *   so tests that don't need a diff still work without extra config.
 */
function makeProxyTx(
  cognitoSub: string | null,
  roleNames: string[],
  currentRoleNames: string[] = roleNames
): unknown {
  let lastFromSentinel: { _schemaName: string } | null = null
  let returningCallCount = 0
  const self: Record<string, unknown> = {}

  const handler: ProxyHandler<typeof self> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown[]) => void) => {
          // Dispatch on which table was queried, not on call count —
          // robust to any reordering of SQL statements in the transaction.
          let rows: unknown[]
          if (lastFromSentinel?._schemaName === 'userRoles') {
            // "Fetch current role assignments" SELECT and "admin count" SELECT
            // both query the userRoles table; both get currentRoleNames rows.
            rows = currentRoleNames.map((name, i) => ({
              id: i + 1, name, roleName: name, count: 2,
            }))
          } else if (lastFromSentinel?._schemaName === 'roles') {
            // Role-name validation SELECT queries the roles table directly.
            rows = roleNames.map((name, i) => ({
              id: i + 1, name, roleName: name, count: 2,
            }))
          } else {
            rows = []
          }
          lastFromSentinel = null
          resolve(rows)
        }
      }
      if (prop === 'from') {
        // Capture which schema sentinel was passed so `then` can dispatch correctly.
        return (table: { _schemaName?: string }) => {
          lastFromSentinel = (table && '_schemaName' in table) ? table as { _schemaName: string } : null
          return proxy
        }
      }
      if (prop === 'returning') {
        return () =>
          Promise.resolve(
            ++returningCallCount === 1 ? [{ id: 42, cognitoSub }] : []
          )
      }
      return () => proxy
    },
  }

  const proxy = new Proxy(self, handler)
  return proxy
}

/**
 * Build a Proxy-based `tx` for use inside the deleteUser transaction callback.
 *
 * deleteUser's transaction does:
 *   1. select admin check          → [] (user is not admin; skips count check)
 *   2. delete(userRoles).where()   → void (ignored; resolved via `then`)
 *   3. delete(users).where().returning({ id, cognitoSub }) → [{id:42, cognitoSub}]
 *
 * `then` always resolves to [] so the admin-check select finds no rows and the
 * delete(userRoles) await resolves cleanly without a special return value.
 * The first `.returning()` call yields the captured cognitoSub.
 */
function makeDeleteProxyTx(cognitoSub: string | null): unknown {
  let returningCallCount = 0
  const self: Record<string, unknown> = {}

  const handler: ProxyHandler<typeof self> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown[]) => void) => resolve([])
      }
      if (prop === 'returning') {
        return () =>
          Promise.resolve(
            ++returningCallCount === 1 ? [{ id: 42, cognitoSub }] : []
          )
      }
      return () => proxy
    },
  }

  const proxy = new Proxy(self, handler)
  return proxy
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type UpdateUserFn = (
  userId: number,
  data: { firstName: string; lastName: string; roles: string[] }
) => Promise<{ isSuccess: boolean; message: string }>

/**
 * Load updateUser with a fresh module registry so we can control ALL its
 * dependencies without fighting the global jest.setup.js mocks.
 */
async function loadUpdateUser(opts: {
  cognitoSub: string | null
  roles?: string[]
  currentRoles?: string[]
  onInvalidateUser: jest.Mock
}): Promise<UpdateUserFn> {
  const { cognitoSub, roles = ['student'], currentRoles, onInvalidateUser } = opts
  let fn!: UpdateUserFn

  jest.isolateModules(() => {
    // Auth mocks
    jest.doMock('@/lib/auth/server-session', () => ({
      getServerSession: jest.fn().mockResolvedValue({ sub: 'admin-sub', email: 'admin@example.com' }),
    }))
    jest.doMock('@/lib/auth/role-helpers', () => ({
      requireRole: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock('@/lib/auth/polling-session-cache', () => ({
      pollingSessionCache: { invalidateUser: onInvalidateUser },
    }))

    // DB mocks
    jest.doMock('@/lib/db/drizzle', () => ({
      // getUserIdByCognitoSubAsNumber is imported by deleteUser for the
      // self-deletion guard; updateUser doesn't call it, but the module-level
      // import still executes, so it must resolve.
      getUserIdByCognitoSubAsNumber: jest.fn().mockResolvedValue(null),
    }))
    jest.doMock('@/lib/db/drizzle-client', () => ({
      executeTransaction: jest.fn((cb: (tx: unknown) => Promise<void>) =>
        cb(makeProxyTx(cognitoSub, roles, currentRoles))
      ),
      executeQuery: jest.fn().mockResolvedValue([]),
    }))

    // Schema stubs — use SCHEMA_SENTINELS so the Proxy's .from() interceptor
    // can distinguish which table is being queried and return the right rows.
    jest.doMock('@/lib/db/schema', () => ({
      users:     SCHEMA_SENTINELS.users,
      userRoles: SCHEMA_SENTINELS.userRoles,
      roles:     SCHEMA_SENTINELS.roles,
    }))
    jest.doMock('@/lib/db/schema/tables/nexus-conversations', () => ({ nexusConversations: {} }))
    jest.doMock('@/lib/db/schema/tables/prompt-usage-events', () => ({ promptUsageEvents: {} }))
    jest.doMock('@/lib/date-utils', () => ({ getDateThreshold: jest.fn() }))
    jest.doMock('drizzle-orm', () => ({
      eq: jest.fn(),
      sql: jest.fn(),
      desc: jest.fn(),
      count: jest.fn(() => 'count()'),
      inArray: jest.fn(),
      ilike: jest.fn(),
      or: jest.fn(),
      and: jest.fn(),
    }))

    // Logger / error-utils
    jest.doMock('@/lib/logger', () => ({
      createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
      generateRequestId: () => 'req-test',
      startTimer: () => jest.fn(),
      sanitizeForLogging: (v: unknown) => v,
    }))
    jest.doMock('@/lib/error-utils', () => ({
      handleError: jest.fn((_: unknown, msg: string) => ({ isSuccess: false, message: msg })),
      ErrorFactories: {
        authNoSession: jest.fn(() => new Error('no session')),
        authInsufficientPermission: jest.fn(() => new Error('no permission')),
        missingRequiredField: jest.fn((f: string) => new Error(`missing ${f}`)),
        dbRecordNotFound: jest.fn(() => new Error('not found')),
        invalidInput: jest.fn(() => new Error('invalid input')),
        bizInvalidState: jest.fn(() => new Error('invalid state')),
      },
      createSuccess: jest.fn((_data: unknown, msg: string) => ({ isSuccess: true, message: msg })),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fn = require('@/actions/admin/user-management.actions').updateUser as UpdateUserFn
  })

  return fn
}

type DeleteUserFn = (userId: number) => Promise<{ isSuccess: boolean; message: string }>

/**
 * Load deleteUser with a fresh module registry, mirroring loadUpdateUser.
 *
 * @param adminDbId - The numeric DB ID returned for the current admin's sub.
 *   Defaults to 999, which is different from the test's target userId (42),
 *   so the self-deletion guard does not fire in the normal path.
 *   Pass 42 to test the guard itself (self-deletion should be rejected).
 */
async function loadDeleteUser(opts: {
  cognitoSub: string | null
  onInvalidateUser: jest.Mock
  adminDbId?: number | null
}): Promise<DeleteUserFn> {
  const { cognitoSub, onInvalidateUser, adminDbId = 999 } = opts
  let fn!: DeleteUserFn

  jest.isolateModules(() => {
    // Auth mocks
    jest.doMock('@/lib/auth/server-session', () => ({
      getServerSession: jest.fn().mockResolvedValue({
        sub: 'admin-sub',
        email: 'admin@example.com',
      }),
    }))
    jest.doMock('@/lib/auth/role-helpers', () => ({
      requireRole: jest.fn().mockResolvedValue(undefined),
    }))
    jest.doMock('@/lib/auth/polling-session-cache', () => ({
      pollingSessionCache: { invalidateUser: onInvalidateUser },
    }))

    // DB mocks
    jest.doMock('@/lib/db/drizzle', () => ({
      // Resolves session.sub → numeric DB ID for the self-deletion guard.
      // adminDbId=999 (default) != target userId 42, so guard doesn't fire.
      // adminDbId=42 causes the guard to reject the delete (self-deletion test).
      getUserIdByCognitoSubAsNumber: jest.fn().mockResolvedValue(adminDbId),
    }))
    jest.doMock('@/lib/db/drizzle-client', () => ({
      executeTransaction: jest.fn((cb: (tx: unknown) => Promise<void>) =>
        cb(makeDeleteProxyTx(cognitoSub))
      ),
      executeQuery: jest.fn().mockResolvedValue([]),
    }))

    // Schema stubs
    jest.doMock('@/lib/db/schema', () => ({
      users: {},
      userRoles: {},
      roles: {},
    }))
    jest.doMock('@/lib/db/schema/tables/nexus-conversations', () => ({ nexusConversations: {} }))
    jest.doMock('@/lib/db/schema/tables/prompt-usage-events', () => ({ promptUsageEvents: {} }))
    jest.doMock('@/lib/date-utils', () => ({ getDateThreshold: jest.fn() }))
    jest.doMock('drizzle-orm', () => ({
      eq: jest.fn(),
      sql: jest.fn(),
      desc: jest.fn(),
      count: jest.fn(() => 'count()'),
      inArray: jest.fn(),
      ilike: jest.fn(),
      or: jest.fn(),
      and: jest.fn(),
    }))

    // Logger / error-utils
    jest.doMock('@/lib/logger', () => ({
      createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
      generateRequestId: () => 'req-test',
      startTimer: () => jest.fn(),
      sanitizeForLogging: (v: unknown) => v,
    }))
    jest.doMock('@/lib/error-utils', () => ({
      handleError: jest.fn((_: unknown, msg: string) => ({ isSuccess: false, message: msg })),
      ErrorFactories: {
        authNoSession: jest.fn(() => new Error('no session')),
        authInsufficientPermission: jest.fn(() => new Error('no permission')),
        missingRequiredField: jest.fn((f: string) => new Error(`missing ${f}`)),
        dbRecordNotFound: jest.fn(() => new Error('not found')),
        invalidInput: jest.fn(() => new Error('invalid input')),
        bizInvalidState: jest.fn(() => new Error('invalid state')),
      },
      createSuccess: jest.fn((_data: unknown, msg: string) => ({ isSuccess: true, message: msg })),
    }))

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fn = require('@/actions/admin/user-management.actions').deleteUser as DeleteUserFn
  })

  return fn
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('updateUser — pollingSessionCache.invalidateUser wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('calls invalidateUser(cognitoSub) after a successful role update', async () => {
    const mockInvalidateUser = jest.fn()
    // currentRoles differs from incoming roles so rolesChanged = true → cache flush fires
    const updateUser = await loadUpdateUser({
      cognitoSub: STUB_SUB,
      roles: ['student'],
      currentRoles: ['staff'],
      onInvalidateUser: mockInvalidateUser,
    })

    const result = await updateUser(42, { firstName: 'Alice', lastName: 'Smith', roles: ['student'] })

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).toHaveBeenCalledTimes(1)
    expect(mockInvalidateUser).toHaveBeenCalledWith(STUB_SUB)
  })

  it('does NOT call invalidateUser on a name-only edit (roles unchanged)', async () => {
    const mockInvalidateUser = jest.fn()
    // currentRoles === incoming roles → rolesChanged = false → cache flush skipped
    const updateUser = await loadUpdateUser({
      cognitoSub: STUB_SUB,
      roles: ['student'],
      currentRoles: ['student'],
      onInvalidateUser: mockInvalidateUser,
    })

    const result = await updateUser(42, { firstName: 'Alice', lastName: 'New-Name', roles: ['student'] })

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).not.toHaveBeenCalled()
  })

  it('does NOT call invalidateUser when cognitoSub is null (user never completed sign-in)', async () => {
    const mockInvalidateUser = jest.fn()
    const updateUser = await loadUpdateUser({
      cognitoSub: null,
      roles: ['student'],
      currentRoles: ['staff'],
      onInvalidateUser: mockInvalidateUser,
    })

    const result = await updateUser(42, { firstName: 'Bob', lastName: 'Jones', roles: ['student'] })

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).not.toHaveBeenCalled()
  })
})

describe('deleteUser — pollingSessionCache.invalidateUser wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('calls invalidateUser(cognitoSub) after a successful user deletion', async () => {
    const mockInvalidateUser = jest.fn()
    const deleteUser = await loadDeleteUser({ cognitoSub: STUB_SUB, onInvalidateUser: mockInvalidateUser })

    const result = await deleteUser(42)

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).toHaveBeenCalledTimes(1)
    expect(mockInvalidateUser).toHaveBeenCalledWith(STUB_SUB)
  })

  it('does NOT call invalidateUser when cognitoSub is null (user never completed sign-in)', async () => {
    const mockInvalidateUser = jest.fn()
    const deleteUser = await loadDeleteUser({ cognitoSub: null, onInvalidateUser: mockInvalidateUser })

    const result = await deleteUser(42)

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).not.toHaveBeenCalled()
  })

  it('rejects self-deletion when the admin DB id matches the target userId', async () => {
    const mockInvalidateUser = jest.fn()
    // adminDbId=42 matches the target userId=42 → guard must fire and reject.
    const deleteUser = await loadDeleteUser({
      cognitoSub: STUB_SUB,
      onInvalidateUser: mockInvalidateUser,
      adminDbId: 42,
    })

    const result = await deleteUser(42)

    expect(result.isSuccess).toBe(false)
    // Guard fires before the transaction, so cache must NOT be invalidated.
    expect(mockInvalidateUser).not.toHaveBeenCalled()
  })

  it('rejects the delete (fail-closed) when the admin DB id cannot be resolved (null)', async () => {
    const mockInvalidateUser = jest.fn()
    // adminDbId=null simulates a DB-connectivity blip or missing JIT record.
    // The guard must block rather than silently allow the delete.
    const deleteUser = await loadDeleteUser({
      cognitoSub: STUB_SUB,
      onInvalidateUser: mockInvalidateUser,
      adminDbId: null,
    })

    const result = await deleteUser(42)

    expect(result.isSuccess).toBe(false)
    expect(mockInvalidateUser).not.toHaveBeenCalled()
  })
})
