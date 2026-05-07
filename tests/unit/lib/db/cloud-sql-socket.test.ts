/**
 * Unit tests for CLOUD_SQL_SOCKET_PATH branch in drizzle-client.ts
 *
 * Verifies:
 * - Rejects relative socket paths (no leading '/')
 * - Rejects missing DB_USER / DB_PASSWORD when socket path is set
 * - Creates postgres client with socket host and ssl:false when path is valid
 * - Falls through to DATABASE_URL path when CLOUD_SQL_SOCKET_PATH is unset
 *
 * Uses jest.resetModules() + require() to get a fresh module per test so the
 * pgClient singleton doesn't bleed between test cases.
 */
// @ts-nocheck — require() calls needed for jest.resetModules() singleton isolation

// Remove the global mock from jest.setup.js so we can load the real module.
// jest.setup.js registers jest.mock('@/lib/db/drizzle-client', ...) globally to
// prevent DB connections in most tests. This file tests the real implementation,
// so we must undo that registration here (hoisted before any imports).
jest.unmock("@/lib/db/drizzle-client")

// postgres mock — registered before any module load
const mockPostgresClient = { end: jest.fn() }
const mockPostgres = jest.fn(() => mockPostgresClient)
jest.mock("postgres", () => mockPostgres)

// drizzle mocks — both the adapter and core are imported by drizzle-client
jest.mock("drizzle-orm/postgres-js", () => ({
  drizzle: jest.fn(() => ({})),
}))
jest.mock("drizzle-orm", () => ({
  sql: jest.fn(),
  eq: jest.fn(),
  and: jest.fn(),
  desc: jest.fn(),
  asc: jest.fn(),
  or: jest.fn(),
  inArray: jest.fn(),
  not: jest.fn(),
  isNull: jest.fn(),
  isNotNull: jest.fn(),
  count: jest.fn(),
  gt: jest.fn(),
  gte: jest.fn(),
  lt: jest.fn(),
  lte: jest.fn(),
  ne: jest.fn(),
}))

// Logger stub
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  generateRequestId: () => "test-req-id",
  startTimer: () => jest.fn(),
}))

// rds-error-handler stub
jest.mock("@/lib/db/rds-error-handler", () => ({
  executeWithRetry: jest.fn((fn) => fn()),
  getCircuitBreakerState: jest.fn(() => ({ state: "CLOSED" })),
  resetCircuitBreaker: jest.fn(),
}))

// schema stub
jest.mock("@/lib/db/schema", () => ({}))

/** Load a fresh drizzle-client module so the pgClient singleton starts null. */
function loadFreshModule() {
  jest.resetModules()
  return require("@/lib/db/drizzle-client")
}

describe("drizzle-client Cloud SQL socket path validation", () => {
  const ORIG_ENV = process.env

  beforeEach(() => {
    mockPostgres.mockClear()
    mockPostgres.mockImplementation(() => mockPostgresClient)
    process.env = { ...ORIG_ENV, NODE_ENV: "test" }
  })

  afterEach(() => {
    process.env = ORIG_ENV
  })

  it("throws when CLOUD_SQL_SOCKET_PATH is a relative path (no leading /)", () => {
    process.env.CLOUD_SQL_SOCKET_PATH = "cloudsql/project:region:instance"
    process.env.DB_USER = "aistudio"
    process.env.DB_PASSWORD = "secret"

    const mod = loadFreshModule()
    expect(() => mod.getPgClientForTesting()).toThrow(
      /must be an absolute path starting with '\//i
    )
  })

  it("throws when CLOUD_SQL_SOCKET_PATH is set but DB_USER is missing", () => {
    process.env.CLOUD_SQL_SOCKET_PATH = "/cloudsql/project:region:instance"
    delete process.env.DB_USER
    process.env.DB_PASSWORD = "secret"

    const mod = loadFreshModule()
    expect(() => mod.getPgClientForTesting()).toThrow(/DB_USER or DB_PASSWORD is missing/i)
  })

  it("throws when CLOUD_SQL_SOCKET_PATH is set but DB_PASSWORD is missing", () => {
    process.env.CLOUD_SQL_SOCKET_PATH = "/cloudsql/project:region:instance"
    process.env.DB_USER = "aistudio"
    delete process.env.DB_PASSWORD

    const mod = loadFreshModule()
    expect(() => mod.getPgClientForTesting()).toThrow(/DB_USER or DB_PASSWORD is missing/i)
  })

  it("creates postgres client with socket host and ssl:false when path is valid", () => {
    const socketPath = "/cloudsql/my-project:us-central1:my-db"
    process.env.CLOUD_SQL_SOCKET_PATH = socketPath
    process.env.DB_USER = "aistudio"
    process.env.DB_PASSWORD = "secret"
    process.env.DB_NAME = "testdb"

    const mod = loadFreshModule()
    mod.getPgClientForTesting()

    expect(mockPostgres).toHaveBeenCalledWith(
      expect.objectContaining({
        host: socketPath,
        user: "aistudio",
        password: "secret",
        database: "testdb",
        ssl: false,
      })
    )
  })

  it("falls through to DATABASE_URL path when CLOUD_SQL_SOCKET_PATH is unset", () => {
    delete process.env.CLOUD_SQL_SOCKET_PATH
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/aistudio"
    process.env.DB_SSL = "false"

    const mod = loadFreshModule()
    mod.getPgClientForTesting()

    // postgres called with a URL string, not an options object
    expect(mockPostgres).toHaveBeenCalledWith(
      "postgresql://user:pass@localhost:5432/aistudio",
      expect.objectContaining({ ssl: false })
    )
  })
})
