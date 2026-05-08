/**
 * Unit tests for validateEnv() in lib/env-validation.ts
 *
 * Covers the branching logic for the GCP deployment:
 * - Auth: Google OIDC required (both ID + secret), partial config (ID without secret)
 * - Database: DATABASE_URL, TCP (DB_HOST+USER+PASS), socket (CLOUD_SQL+USER+PASS),
 *   none configured (should fail)
 * - Required vars: AUTH_URL, AUTH_SECRET, GCS_BUCKET
 */

import { validateEnv } from "@/lib/env-validation"

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
