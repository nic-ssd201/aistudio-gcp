/**
 * Unit tests for resolveUserId (lib/auth/resolve-user.ts)
 *
 * Covers the three code paths:
 *  1. Fast path  — user found by sub  → return immediately, no DB writes
 *  2. Email path — user not found by sub, found by email → link sub, no create
 *  3. New user   — not found by either → create + assign default role
 *
 * Also covers error branches:
 *  - Missing email on new-user path → throws
 *  - Role assignment failure (not-found)  → non-fatal, user still provisioned
 *  - Role assignment failure (infra error) → non-fatal, logged as error
 *  - getUserByEmail throws infra error → re-thrown
 *  - createUser returns no valid ID → throws
 *
 * Username → default-role heuristic:
 *  - All-digit username  → student  (e.g. "123456@psd401.net")
 *  - Non-digit username  → staff    (e.g. "jsmith@psd401.net")
 *
 * Note: this file uses the global `jest` object (not `import { jest } from "@jest/globals"`)
 * because jest.mock() factories are hoisted before ESM imports — a factory that
 * closes over the @jest/globals `jest` binding gets `undefined` at hoist time.
 */

import { ErrorCode } from "@/types/error-types"

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/db/drizzle", () => ({
  getUserIdByCognitoSubAsNumber: jest.fn(),
  getUserByEmail: jest.fn(),
  updateUser: jest.fn(),
  createUser: jest.fn(),
  addUserRole: jest.fn(),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  sanitizeForLogging: jest.fn((v: unknown) => v),
}))

jest.mock("@/lib/error-utils", () => ({
  ErrorFactories: {
    missingRequiredField: jest.fn((field: string) =>
      Object.assign(new Error(`Missing: ${field}`), { code: "MISSING_REQUIRED_FIELD" })
    ),
    dbQueryFailed: jest.fn((_op: string, err: Error) => err),
    dbRecordNotFound: jest.fn((table: string, id: unknown) =>
      Object.assign(new Error(`not found: ${table} ${id}`), {
        code: ErrorCode.DB_RECORD_NOT_FOUND,
      })
    ),
  },
}))

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  getUserIdByCognitoSubAsNumber,
  getUserByEmail,
  updateUser,
  createUser,
  addUserRole,
} from "@/lib/db/drizzle"

import { resolveUserId } from "@/lib/auth/resolve-user"

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockGetById   = jest.mocked(getUserIdByCognitoSubAsNumber)
const mockGetByEmail = jest.mocked(getUserByEmail)
const mockUpdateUser = jest.mocked(updateUser)
const mockCreateUser = jest.mocked(createUser)
const mockAddRole    = jest.mocked(addUserRole)

// ── Stubs ──────────────────────────────────────────────────────────────────────

const STUB_USER_ID = 42
const STUB_SUB     = "google-sub-xyz"
const STUB_EMAIL   = "jsmith@psd401.net"

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sub: STUB_SUB,
    email: STUB_EMAIL,
    givenName: "Jane",
    familyName: "Smith",
    ...overrides,
  }
}

function makeNotFoundError() {
  return Object.assign(new Error("not found"), { code: ErrorCode.DB_RECORD_NOT_FOUND })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("resolveUserId()", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── Fast path ──────────────────────────────────────────────────────────────

  describe("fast path — user exists by sub", () => {
    it("returns the numeric user ID without any DB writes", async () => {
      mockGetById.mockResolvedValue(STUB_USER_ID)

      const result = await resolveUserId(makeSession())

      expect(result).toBe(STUB_USER_ID)
      expect(mockGetByEmail).not.toHaveBeenCalled()
      expect(mockUpdateUser).not.toHaveBeenCalled()
      expect(mockCreateUser).not.toHaveBeenCalled()
      expect(mockAddRole).not.toHaveBeenCalled()
    })
  })

  // ── Email path ─────────────────────────────────────────────────────────────

  describe("email path — user not found by sub, found by email", () => {
    beforeEach(() => {
      mockGetById.mockResolvedValue(null)
    })

    it("links the OIDC sub to the existing record and returns the existing ID", async () => {
      mockGetByEmail.mockResolvedValue({ id: STUB_USER_ID, email: STUB_EMAIL } as never)
      mockUpdateUser.mockResolvedValue(undefined as never)

      const result = await resolveUserId(makeSession())

      expect(result).toBe(STUB_USER_ID)
      expect(mockUpdateUser).toHaveBeenCalledWith(STUB_USER_ID, { cognitoSub: STUB_SUB })
      expect(mockCreateUser).not.toHaveBeenCalled()
      expect(mockAddRole).not.toHaveBeenCalled()
    })

    it("falls through to create when getUserByEmail throws DB_RECORD_NOT_FOUND", async () => {
      mockGetByEmail.mockRejectedValue(makeNotFoundError())
      mockCreateUser.mockResolvedValue({ id: STUB_USER_ID } as never)
      mockAddRole.mockResolvedValue({ success: true })

      const result = await resolveUserId(makeSession())

      expect(result).toBe(STUB_USER_ID)
      expect(mockCreateUser).toHaveBeenCalledTimes(1)
    })

    it("re-throws when getUserByEmail throws a non-not-found error", async () => {
      const infraError = new Error("DB connection refused")
      mockGetByEmail.mockRejectedValue(infraError)

      await expect(resolveUserId(makeSession())).rejects.toThrow("DB connection refused")
      expect(mockCreateUser).not.toHaveBeenCalled()
    })
  })

  // ── New user path ──────────────────────────────────────────────────────────

  describe("new user path — not found by sub or email", () => {
    beforeEach(() => {
      mockGetById.mockResolvedValue(null)
      mockGetByEmail.mockRejectedValue(makeNotFoundError())
      mockCreateUser.mockResolvedValue({ id: STUB_USER_ID } as never)
      mockAddRole.mockResolvedValue({ success: true })
    })

    it("creates the user and assigns the default role", async () => {
      const result = await resolveUserId(makeSession())

      expect(result).toBe(STUB_USER_ID)
      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({ cognitoSub: STUB_SUB, email: STUB_EMAIL })
      )
      expect(mockAddRole).toHaveBeenCalledWith(STUB_USER_ID, expect.any(String))
    })

    it("assigns 'student' role for all-digit username (K-12 district convention)", async () => {
      await resolveUserId(makeSession({ email: "123456@psd401.net" }))
      expect(mockAddRole).toHaveBeenCalledWith(STUB_USER_ID, "student")
    })

    it("assigns 'staff' role for non-digit username", async () => {
      await resolveUserId(makeSession({ email: "jsmith@psd401.net" }))
      expect(mockAddRole).toHaveBeenCalledWith(STUB_USER_ID, "staff")
    })

    it("uses givenName as firstName when present", async () => {
      await resolveUserId(makeSession({ givenName: "Jane", familyName: "Smith" }))
      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: "Jane", lastName: "Smith" })
      )
    })

    it("falls back to username segment as firstName when givenName is absent", async () => {
      await resolveUserId(
        makeSession({ givenName: undefined, familyName: undefined, email: "jsmith@psd401.net" })
      )
      expect(mockCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: "jsmith" })
      )
    })

    it("throws missingRequiredField when session has no email", async () => {
      // Reset email-path mock so it doesn't intercept (no email → skip email lookup)
      mockGetByEmail.mockResolvedValue(null as never)

      await expect(resolveUserId(makeSession({ email: undefined }))).rejects.toThrow("Missing: email")
      expect(mockCreateUser).not.toHaveBeenCalled()
    })

    it("throws when createUser returns no valid ID (id=0)", async () => {
      mockCreateUser.mockResolvedValue({ id: 0 } as never)

      await expect(resolveUserId(makeSession())).rejects.toThrow()
      expect(mockAddRole).not.toHaveBeenCalled()
    })

    it("still returns userId when role assignment fails with not-found (non-fatal)", async () => {
      mockAddRole.mockRejectedValue(makeNotFoundError())

      // Role failure is non-fatal — user is still provisioned
      const result = await resolveUserId(makeSession())
      expect(result).toBe(STUB_USER_ID)
    })

    it("still returns userId when role assignment fails with infra error (non-fatal)", async () => {
      mockAddRole.mockRejectedValue(new Error("deadlock detected"))

      const result = await resolveUserId(makeSession())
      expect(result).toBe(STUB_USER_ID)
    })
  })
})
