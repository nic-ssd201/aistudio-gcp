/**
 * Unit tests for validateEnv() in lib/env-validation.ts
 *
 * Covers the branching logic added for the GCP migration:
 * - Auth provider: Cognito-only, Google-only, both, neither (should fail),
 *   partial Google config (ID without secret)
 * - Database: DATABASE_URL, TCP (DB_HOST+USER+PASS), socket (CLOUD_SQL+USER+PASS),
 *   none configured (should fail)
 * - AWS region warning only on AWS deployments
 */

import { validateEnv } from "@/lib/env-validation"

// Minimal valid env that passes all required checks
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  AUTH_URL: "https://aistudio.example.com",
  AUTH_SECRET: "test-secret-32chars-padding-here",
  // Auth provider — Google only (GCP deployment)
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
  // Database — DATABASE_URL (local dev)
  DATABASE_URL: "postgresql://user:pass@localhost:5432/aistudio",
  // Storage
  GCS_BUCKET_NAME: "aistudio-docs",
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

  it("passes with Google-only auth provider", () => {
    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(true)
    expect(missing).toHaveLength(0)
  })

  it("passes with Cognito-only auth provider", () => {
    delete process.env.AUTH_GOOGLE_ID
    delete process.env.AUTH_GOOGLE_SECRET
    process.env.AUTH_COGNITO_CLIENT_ID = "cognito-client-id"
    process.env.AUTH_COGNITO_CLIENT_SECRET = "cognito-client-secret"
    process.env.AUTH_COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/pool"

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(true)
    expect(missing).toHaveLength(0)
  })

  it("passes with both Cognito and Google configured", () => {
    process.env.AUTH_COGNITO_CLIENT_ID = "cognito-client-id"
    process.env.AUTH_COGNITO_CLIENT_SECRET = "cognito-client-secret"
    process.env.AUTH_COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/pool"

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(true)
    expect(missing).toHaveLength(0)
  })

  it("fails when neither Cognito nor Google is configured", () => {
    delete process.env.AUTH_GOOGLE_ID
    delete process.env.AUTH_GOOGLE_SECRET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("auth provider required"))).toBe(true)
  })

  it("fails when AUTH_GOOGLE_ID is set without AUTH_GOOGLE_SECRET", () => {
    delete process.env.AUTH_GOOGLE_SECRET

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("AUTH_GOOGLE_SECRET"))).toBe(true)
  })

  it("fails when Cognito CLIENT_ID is set but ISSUER is missing (incomplete Cognito)", () => {
    delete process.env.AUTH_GOOGLE_ID
    delete process.env.AUTH_GOOGLE_SECRET
    process.env.AUTH_COGNITO_CLIENT_ID = "cognito-client-id"
    // No AUTH_COGNITO_ISSUER → incomplete Cognito, falls through to "no provider" error

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing.some((m) => m.includes("auth provider required"))).toBe(true)
  })

  // ── Database connection mode ──────────────────────────────────────────────

  it("passes with DATABASE_URL", () => {
    const { isValid } = validateEnv()
    expect(isValid).toBe(true)
  })

  it("passes with TCP config (DB_HOST + DB_USER + DB_PASSWORD)", () => {
    delete process.env.DATABASE_URL
    process.env.DB_HOST = "aurora-cluster.us-east-1.rds.amazonaws.com"
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
    process.env.DB_HOST = "aurora-cluster.us-east-1.rds.amazonaws.com"
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

  it("fails when GCS_BUCKET_NAME is missing", () => {
    delete process.env.GCS_BUCKET_NAME

    const { isValid, missing } = validateEnv()
    expect(isValid).toBe(false)
    expect(missing).toContain("GCS_BUCKET_NAME")
  })

  // ── AWS region warning ────────────────────────────────────────────────────

  it("warns about missing AWS region on AWS (Cognito) deployments", () => {
    process.env.AUTH_COGNITO_CLIENT_ID = "cognito-client-id"
    process.env.AUTH_COGNITO_CLIENT_SECRET = "cognito-client-secret"
    process.env.AUTH_COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/pool"
    delete process.env.AWS_REGION
    delete process.env.AWS_DEFAULT_REGION
    delete process.env.NEXT_PUBLIC_AWS_REGION

    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes("AWS deployment detected"))).toBe(true)
  })

  it("does not warn about missing AWS region on GCP-only (Google) deployments", () => {
    // No Cognito, no DB_HOST, no AWS_REGION → not detected as AWS deployment.
    // The "AWS deployment detected" warning must NOT appear; the generic optional-
    // var notice for NEXT_PUBLIC_AWS_REGION may still appear and is acceptable.
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes("AWS deployment detected"))).toBe(false)
  })
})
