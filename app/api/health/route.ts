import { NextResponse } from "next/server"
import { validateDatabaseConnection } from "@/lib/db/drizzle-client"
import { getServerSession } from "@/lib/auth/server-session"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { validateEnv } from "@/lib/env-validation"

/**
 * Health Check API Endpoint — SSD201 GCP deployment
 *
 * Validates:
 * - Environment variable configuration (Google OIDC + GCS)
 * - Database connectivity (postgres.js — DATABASE_URL, TCP, or Cloud SQL socket)
 * - Authentication (NextAuth v5 + Google OIDC)
 *
 * **Response design (info-leak mitigation):**
 * Load-balancer and Docker probes only need the HTTP status code (200/503).
 * The response body is intentionally minimal for production callers so that
 * unauthenticated probers cannot enumerate which credentials are missing or
 * infer the infrastructure topology from the response body.
 *
 * - All environments: `{status, timestamp, checks: {<name>: {status}}}` +
 *   `hasSession` (boolean — never the session user's email).
 * - Non-production only: `missingVariables[]`, per-check `connectionType`,
 *   and `diagnostics.hints[]` are included to ease local debugging.
 */
export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.health");
  const log = createLogger({ requestId, route: "api.health" });
  const isDev = process.env.NODE_ENV !== 'production';

  log.info("GET /api/health - Health check requested");

  // Run all three checks in parallel so the endpoint is fast for LB probes.
  const [envResult, sessionResult, dbResult] = await Promise.allSettled([
    // ── 1. Environment ────────────────────────────────────────────────────────
    (async () => {
      const { isValid, missing } = validateEnv()
      log.debug("Environment check completed", { missingVars: missing.length });
      return { isValid, missing }
    })(),

    // ── 2. Authentication ─────────────────────────────────────────────────────
    // Only attempt if the Google OIDC vars are present; otherwise the
    // NextAuth config itself would be invalid.
    (async () => {
      if (
        !process.env.AUTH_SECRET ||
        !process.env.AUTH_GOOGLE_ID ||
        !process.env.AUTH_GOOGLE_SECRET
      ) {
        return { configured: false, hasSession: false }
      }
      const session = await getServerSession()
      log.debug("Authentication check completed", { hasSession: !!session });
      // Never expose session user identity (email, name, sub) in the response
      // body — only confirm whether a valid session exists.
      return { configured: true, hasSession: !!session }
    })(),

    // ── 3. Database ───────────────────────────────────────────────────────────
    (async () => {
      const hasDatabaseUrl = !!process.env.DATABASE_URL;
      const hasDbHost = !!process.env.DB_HOST;
      const hasCloudSqlSocket = !!process.env.CLOUD_SQL_SOCKET_PATH;

      const connectionType = hasDatabaseUrl
        ? 'DATABASE_URL'
        : hasDbHost
          ? 'DB_HOST'
          : hasCloudSqlSocket
            ? 'CLOUD_SQL_SOCKET_PATH'
            : null;

      if (!connectionType) {
        return { connected: false, connectionType: null }
      }

      const validation = await validateDatabaseConnection()
      log.debug("Database check completed", { success: validation.success });
      return { connected: validation.success, connectionType }
    })(),
  ]);

  // ── Build check statuses ───────────────────────────────────────────────────

  const envCheck = envResult.status === 'fulfilled' ? envResult.value : null
  const sessionCheck = sessionResult.status === 'fulfilled' ? sessionResult.value : null
  const dbCheck = dbResult.status === 'fulfilled' ? dbResult.value : null

  const envStatus = envResult.status === 'rejected'
    ? 'error'
    : envCheck!.isValid ? 'healthy' : 'unhealthy'

  const authStatus = sessionResult.status === 'rejected'
    ? 'error'
    : sessionCheck!.configured ? 'healthy' : 'unhealthy'

  const dbStatus = dbResult.status === 'rejected'
    ? 'error'
    : dbCheck!.connected ? 'healthy' : 'unhealthy'

  const allHealthy = envStatus === 'healthy' && authStatus === 'healthy' && dbStatus === 'healthy'

  log.info("Health check completed", {
    status: allHealthy ? 'healthy' : 'unhealthy',
    envStatus,
    authStatus,
    dbStatus,
  });
  timer({ status: allHealthy ? "success" : "unhealthy" });

  // ── Response body ──────────────────────────────────────────────────────────
  // Production: check statuses only — sufficient for LB probes, no info leak.
  // Non-production: add missing-var names, connection type, and hints to ease
  // local debugging.

  const body: Record<string, unknown> = {
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: {
      environment: {
        status: envStatus,
        // Missing var names exposed in dev only — the names alone don't reveal
        // credential values but do reveal which infra vars are expected.
        ...(isDev && envCheck?.missing.length
          ? { missingVariables: envCheck.missing }
          : {}),
      },
      authentication: {
        status: authStatus,
        // Boolean only — never expose session user identity in probe response.
        hasSession: sessionCheck?.hasSession ?? false,
      },
      database: {
        status: dbStatus,
        // Connection type exposed in dev: reveals infrastructure topology.
        ...(isDev && dbCheck?.connectionType
          ? { connectionType: dbCheck.connectionType }
          : {}),
      },
    },
  }

  // Append lightweight hints in non-production to help developers diagnose failures.
  if (isDev && !allHealthy) {
    const hints: string[] = []
    if (envStatus !== 'healthy') {
      hints.push("Check env vars: AUTH_URL, AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, GCS_BUCKET_NAME, and one of DATABASE_URL / DB_HOST / CLOUD_SQL_SOCKET_PATH.")
    }
    if (authStatus !== 'healthy') {
      hints.push("AUTH_SECRET and both AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET must be set.")
    }
    if (dbStatus !== 'healthy') {
      hints.push(
        dbCheck?.connectionType
          ? "Database connectivity issue. Check credentials and that the instance is reachable."
          : "No database mode configured. Set DATABASE_URL (local), DB_HOST (TCP), or CLOUD_SQL_SOCKET_PATH (Cloud Run)."
      )
    }
    if (hints.length) body.diagnostics = { hints }
  }

  return NextResponse.json(body, {
    status: allHealthy ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
  })
}
