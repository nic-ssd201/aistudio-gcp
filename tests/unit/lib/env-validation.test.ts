/**
 * Unit tests for validateEnv() in lib/env-validation.ts
 *
 * Covers the branching logic for the GCP deployment:
 * - Auth: Google OIDC required (both ID + secret), partial config (ID without secret)
 * - Database: DATABASE_URL, TCP (DB_HOST+USER+PASS), socket (CLOUD_SQL+USER+PASS),
 *   none configured (should fail)
 * - Required vars: AUTH_URL, AUTH_SECRET, GCS_BUCKET
 */

import { validateEnv, requireValidEnv } from "@/lib/env-validation"

// Minimal valid env that passes all required checks
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  AUTH_URL: "https://aistudio.example.com",
  AUTH_SECRET: "test-secret-32chars-padding-here",
  // Auth provider — Google OIDC (required)
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
  // Database — DATABASE_URL (local dev)
  DATABASE_URL: "postgresql://user:pass@localhost:5432/aistudio",
  // Storage
  GCS_BUCKET: "aistudio-docs",
  // AI
  ANTHROPIC_API_KEY: "sk-ant-test",
}

describe("validateEnv()", () => {
  const ORIG_ENV = process.env

  beforeEach(() => {
    process.env = { ...BASE_ENV }
  })

  afterEach(() => {
    process.env = ORIG_ENV
  })

  // ── Auth provider ─────────────────────────────────────────────────────────

  it("passes with Google OIDC configured", () => {
    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(true)
    expect(missing).toHaveLength(0)
  })

  it("fails when neither AUTH_GOOGLE_ID nor AUTH_GOOGLE_SECRET is set", () => {
    delete process.env.AUTH_GOOGLE_ID
    delete process.env.AUTH_GOOGLE_SECRET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are required"))).toBe(true)
  })

  it("fails when AUTH_GOOGLE_ID is whitespace-only — regression pin for stray-space misconfiguration", () => {
    // A value of '  ' passes !!value but fails at runtime with a misleading
    // 'invalid_client' error from Google.  The .trim() check catches this at
    // startup instead.
    process.env.AUTH_GOOGLE_ID = "   "
    delete process.env.AUTH_GOOGLE_SECRET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    // Both are absent after trim, so the pair-check fires.
    expect(missing.some((m) => m.includes("AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are required"))).toBe(true)
  })

  it("fails when AUTH_GOOGLE_ID is set without AUTH_GOOGLE_SECRET", () => {
    delete process.env.AUTH_GOOGLE_SECRET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("AUTH_GOOGLE_SECRET"))).toBe(true)
  })

  it("fails when AUTH_GOOGLE_SECRET is set without AUTH_GOOGLE_ID", () => {
    delete process.env.AUTH_GOOGLE_ID

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("AUTH_GOOGLE_ID"))).toBe(true)
  })

  // ── Database connection mode ──────────────────────────────────────────────

  it("passes with DATABASE_URL", () => {
    const { isValid } = validateEnv()
    expect(isValid).toBe(true)
  })

  it("passes with TCP config (DB_HOST + DB_USER + DB_PASSWORD)", () => {
    delete process.env.DATABASE_URL
    process.env.DB_HOST = "db.example.com"
    process.env.DB_USER = "aistudio"
    process.env.DB_PASSWORD = "secret"

    const { isValid } = validateEnv()
    expect(isValid).toBe(true)
  })

  it("passes with Cloud SQL socket config (CLOUD_SQL_SOCKET_PATH + DB_USER + DB_PASSWORD)", () => {
    delete process.env.DATABASE_URL
    process.env.CLOUD_SQL_SOCKET_PATH = "/cloudsql/proj:us-central1:inst"
    process.env.DB_USER = "aistudio"
    process.env.DB_PASSWORD = "secret"

    const { isValid } = validateEnv()
    expect(isValid).toBe(true)
  })

  it("fails when no database config is provided", () => {
    delete process.env.DATABASE_URL

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("database configuration required"))).toBe(true)
  })

  it("fails with partial TCP config (DB_HOST without credentials)", () => {
    delete process.env.DATABASE_URL
    process.env.DB_HOST = "db.example.com"
    // No DB_USER or DB_PASSWORD

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("database configuration required"))).toBe(true)
  })

  it("fails with partial socket config (CLOUD_SQL_SOCKET_PATH without credentials)", () => {
    delete process.env.DATABASE_URL
    process.env.CLOUD_SQL_SOCKET_PATH = "/cloudsql/proj:us-central1:inst"
    // No DB_USER or DB_PASSWORD

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("database configuration required"))).toBe(true)
  })

  // ── Required vars ─────────────────────────────────────────────────────────

  it("fails when AUTH_URL is missing", () => {
    delete process.env.AUTH_URL

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing).toContain("AUTH_URL")
  })

  it("fails when AUTH_SECRET is missing", () => {
    delete process.env.AUTH_SECRET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing).toContain("AUTH_SECRET")
  })

  it("fails when GCS_BUCKET is missing", () => {
    delete process.env.GCS_BUCKET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing).toContain("GCS_BUCKET")
  })

  // ── AI API keys warning ───────────────────────────────────────────────────

  it("warns when no AI API keys are configured", () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY

    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes("No AI API keys configured"))).toBe(true)
  })

  it("does not warn about AI keys when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"
    delete process.env.OPENAI_API_KEY

    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes("No AI API keys configured"))).toBe(false)
  })

  // ── TOKEN_REFRESH_THRESHOLD_MS validation ────────────────────────────────

  it("warns but stays valid when TOKEN_REFRESH_THRESHOLD_MS is below the 60 000 ms floor", () => {
    process.env.TOKEN_REFRESH_THRESHOLD_MS = "30000"

    const { isValid, warnings } = validateEnv()

    expect(isValid).toBe(true) // operator-visible warning, not a hard failure
    expect(warnings.some((w) => w.includes("TOKEN_REFRESH_THRESHOLD_MS"))).toBe(true)
    expect(warnings.some((w) => w.includes("30000"))).toBe(true)
  })

  it("warns but stays valid when TOKEN_REFRESH_THRESHOLD_MS is non-numeric", () => {
    process.env.TOKEN_REFRESH_THRESHOLD_MS = "not-a-number"

    const { isValid, warnings } = validateEnv()

    expect(isValid).toBe(true)
    expect(warnings.some((w) => w.includes("TOKEN_REFRESH_THRESHOLD_MS"))).toBe(true)
  })

  it("does not warn when TOKEN_REFRESH_THRESHOLD_MS is at or above the 60 000 ms floor", () => {
    process.env.TOKEN_REFRESH_THRESHOLD_MS = "60000"

    const { warnings } = validateEnv()

    expect(warnings.some((w) => w.includes("TOKEN_REFRESH_THRESHOLD_MS"))).toBe(false)
  })

  // ── SESSION_MAX_AGE validation ────────────────────────────────────────────

  it("warns but stays valid when SESSION_MAX_AGE is non-numeric", () => {
    process.env.SESSION_MAX_AGE = "invalid"

    const { isValid, warnings } = validateEnv()

    expect(isValid).toBe(true)
    expect(warnings.some((w) => w.includes("SESSION_MAX_AGE"))).toBe(true)
  })

  it("warns but stays valid when SESSION_MAX_AGE is zero or negative", () => {
    process.env.SESSION_MAX_AGE = "0"

    const { isValid, warnings } = validateEnv()

    expect(isValid).toBe(true)
    expect(warnings.some((w) => w.includes("SESSION_MAX_AGE"))).toBe(true)
  })

  it("warns but stays valid when SESSION_MAX_AGE is below the 600 s soft floor", () => {
    // A value of 60 is almost certainly a unit confusion (seconds vs minutes).
    // The soft-floor warning surfaces this at deploy time rather than silently
    // granting 1-minute sessions.
    process.env.SESSION_MAX_AGE = "60"

    const { isValid, warnings } = validateEnv()

    expect(isValid).toBe(true) // soft floor — warning, not a hard failure
    expect(warnings.some((w) => w.includes("SESSION_MAX_AGE"))).toBe(true)
    expect(warnings.some((w) => w.includes("unusually short"))).toBe(true)
  })

  it("does not warn when SESSION_MAX_AGE is at or above the 600 s soft floor", () => {
    process.env.SESSION_MAX_AGE = "600"

    const { warnings } = validateEnv()

    expect(warnings.some((w) => w.includes("SESSION_MAX_AGE") && w.includes("unusually short"))).toBe(false)
  })

  // ── AUTH_GOOGLE_FORCE_CONSENT validation ──────────────────────────────────

  it("warns but stays valid when AUTH_GOOGLE_FORCE_CONSENT has an unrecognised value", () => {
    process.env.AUTH_GOOGLE_FORCE_CONSENT = "yes"

    const { isValid, warnings } = validateEnv()

    expect(isValid).toBe(true) // warning, not a hard failure
    expect(warnings.some((w) => w.includes("AUTH_GOOGLE_FORCE_CONSENT"))).toBe(true)
    expect(warnings.some((w) => w.includes("yes"))).toBe(true)
  })

  it("does not warn when AUTH_GOOGLE_FORCE_CONSENT is 'true'", () => {
    process.env.AUTH_GOOGLE_FORCE_CONSENT = "true"

    const { warnings } = validateEnv()

    expect(warnings.some((w) => w.includes("AUTH_GOOGLE_FORCE_CONSENT"))).toBe(false)
  })

  it("does not warn when AUTH_GOOGLE_FORCE_CONSENT is 'false'", () => {
    process.env.AUTH_GOOGLE_FORCE_CONSENT = "false"

    const { warnings } = validateEnv()

    expect(warnings.some((w) => w.includes("AUTH_GOOGLE_FORCE_CONSENT"))).toBe(false)
  })

  it("does not warn when AUTH_GOOGLE_FORCE_CONSENT is mixed-case (case-insensitive)", () => {
    process.env.AUTH_GOOGLE_FORCE_CONSENT = "False"

    const { warnings } = validateEnv()

    expect(warnings.some((w) => w.includes("AUTH_GOOGLE_FORCE_CONSENT"))).toBe(false)
  })
})

// ── requireValidEnv — warnings actually reach console.warn ────────────────────
//
// The reviewer (round-46) identified that validateEnv() accumulates warnings
// but requireValidEnv() — the only function that emits them via console.warn —
// was never called in the runtime path.  The fix wires requireValidEnv() into
// instrumentation.ts:register().  These tests pin the warning-emission contract:
// they verify that the three new warning paths (TOKEN_REFRESH_THRESHOLD_MS floor,
// SESSION_MAX_AGE invalid, AUTH_GOOGLE_FORCE_CONSENT unrecognised) actually
// surface via console.warn when requireValidEnv() is called.

describe("requireValidEnv() warning emission", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    // Restore a known-good env for each test.
    Object.assign(process.env, BASE_ENV)
    // requireValidEnv() suppresses console.warn in NODE_ENV=test (to keep Jest
    // output clean).  Set 'development' here so the warning-emission path is
    // actually exercised — this is exactly what we're testing.
    // Cast needed: TypeScript types NODE_ENV as readonly in ProcessEnv, but
    // jest's process.env shim is mutable at runtime.
    ;(process.env as Record<string, string>).NODE_ENV = "development"
    // Capture console.warn calls without polluting Jest output.
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    ;(process.env as Record<string, string>).NODE_ENV = "test"
    warnSpy.mockRestore()
  })

  it("emits console.warn when TOKEN_REFRESH_THRESHOLD_MS is below the 60 000 ms floor", () => {
    process.env.TOKEN_REFRESH_THRESHOLD_MS = "5000"

    requireValidEnv()

    const calls = warnSpy.mock.calls.flat().join(" ")
    expect(calls).toMatch(/TOKEN_REFRESH_THRESHOLD_MS/)
    expect(calls).toMatch(/floor/)
  })

  it("emits console.warn when SESSION_MAX_AGE is not a positive integer", () => {
    process.env.SESSION_MAX_AGE = "abc"

    requireValidEnv()

    const calls = warnSpy.mock.calls.flat().join(" ")
    expect(calls).toMatch(/SESSION_MAX_AGE/)
    expect(calls).toMatch(/positive integer/)
  })

  it("emits console.warn when SESSION_MAX_AGE is below the 600 s soft floor", () => {
    process.env.SESSION_MAX_AGE = "60"

    requireValidEnv()

    const calls = warnSpy.mock.calls.flat().join(" ")
    expect(calls).toMatch(/SESSION_MAX_AGE/)
    expect(calls).toMatch(/unusually short/)
  })

  it("emits console.warn when AUTH_GOOGLE_FORCE_CONSENT has an unrecognised value", () => {
    process.env.AUTH_GOOGLE_FORCE_CONSENT = "yes"

    requireValidEnv()

    const calls = warnSpy.mock.calls.flat().join(" ")
    expect(calls).toMatch(/AUTH_GOOGLE_FORCE_CONSENT/)
  })

  it("does not emit invalid-value warnings when the optional vars are absent", () => {
    // Ensure none of the warning-triggering vars are set.
    // Absent optional vars still produce "Optional variable X is not set" notices,
    // but those are not the invalid-value warnings we're guarding against.
    delete process.env.TOKEN_REFRESH_THRESHOLD_MS
    delete process.env.SESSION_MAX_AGE
    delete process.env.AUTH_GOOGLE_FORCE_CONSENT

    requireValidEnv()

    // The invalid-value warnings include distinctive phrases that never appear
    // in the generic "Optional variable X is not set" lines.
    const calls = warnSpy.mock.calls.flat().join(" ")
    expect(calls).not.toMatch(/floor and will be ignored/)
    expect(calls).not.toMatch(/not a positive integer/)
    expect(calls).not.toMatch(/unusually short/)
    expect(calls).not.toMatch(/not recognised — expected "true" or "false"/)
  })
})
