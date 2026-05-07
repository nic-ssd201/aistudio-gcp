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
 * Build a Proxy-based `tx` for use inside the transaction callback.
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
 */
function makeProxyTx(cognitoSub: string | null, roleNames: string[]): unknown {
  let returningCallCount = 0
  const self: Record<string, unknown> = {}

  const handler: ProxyHandler<typeof self> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown[]) => void) =>
          resolve(roleNames.map((name, i) => ({ id: i + 1, name, roleName: name, count: 2 })))
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
  onInvalidateUser: jest.Mock
}): Promise<UpdateUserFn> {
  const { cognitoSub, roles = ['student'], onInvalidateUser } = opts
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
    jest.doMock('@/lib/db/drizzle-client', () => ({
      executeTransaction: jest.fn((cb: (tx: unknown) => Promise<void>) =>
        cb(makeProxyTx(cognitoSub, roles))
      ),
      executeQuery: jest.fn().mockResolvedValue([]),
    }))

    // Schema stubs — just enough for the action's imports to resolve
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
    fn = require('@/actions/admin/user-management.actions').updateUser as UpdateUserFn
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
    const updateUser = await loadUpdateUser({ cognitoSub: STUB_SUB, onInvalidateUser: mockInvalidateUser })

    const result = await updateUser(42, { firstName: 'Alice', lastName: 'Smith', roles: ['student'] })

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).toHaveBeenCalledTimes(1)
    expect(mockInvalidateUser).toHaveBeenCalledWith(STUB_SUB)
  })

  it('does NOT call invalidateUser when cognitoSub is null (user never completed sign-in)', async () => {
    const mockInvalidateUser = jest.fn()
    const updateUser = await loadUpdateUser({ cognitoSub: null, onInvalidateUser: mockInvalidateUser })

    const result = await updateUser(42, { firstName: 'Bob', lastName: 'Jones', roles: ['student'] })

    expect(result.isSuccess).toBe(true)
    expect(mockInvalidateUser).not.toHaveBeenCalled()
  })
})
