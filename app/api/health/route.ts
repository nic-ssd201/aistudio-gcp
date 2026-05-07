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
 * Returns detailed diagnostic information to help troubleshoot deployment issues.
 * This endpoint is unauthenticated so it can be used by load-balancer health checks.
 *
 * TODO(nic-ssd201/aistudio-gcp#TBD): This endpoint leaks internal deployment
 * detail in its unauthenticated response body — missing env var names, per-var
 * presence flags, session user email, and the deploymentChecklist. LB/Docker
 * probes only need the HTTP status code (200 / 503), so the verbose body is
 * unnecessary for probes. Consider one of:
 *   a) Returning a minimal `{status, timestamp}` body to all callers and
 *      reserving the full diagnostics for requests that include an internal
 *      probe header (e.g. `X-Health-Detail: <shared-secret>`).
 *   b) Gating the full response behind authentication (session cookie present).
 * Until then, treat this endpoint as internal — do not expose it publicly
 * without a WAF rule or Cloud Run ingress restriction.
 */
export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.health");
  const log = createLogger({ requestId, route: "api.health" });

  log.info("GET /api/health - Health check requested");

  interface HealthCheckResult {
    timestamp: string;
    status: string;
    checks: {
      environment: {
        status: string;
        missingVariables?: string[];
        nodeEnv?: string;
        details?: Record<string, unknown>;
        error?: string;
      };
      authentication: {
        status: string;
        hasSession?: boolean;
        sessionUser?: string;
        authConfigured?: boolean;
        error?: string;
        hint?: string;
      };
      database: {
        status: string;
        success?: boolean;
        configured?: boolean;
        connectionType?: string;
        hint?: string;
        error?: unknown;
        [key: string]: unknown;
      };
    };
    diagnostics?: {
      hints: string[];
      deploymentChecklist?: string[];
    };
  }

  const healthCheck: HealthCheckResult = {
    timestamp: new Date().toISOString(),
    status: "checking",
    checks: {
      environment: { status: "pending" },
      authentication: { status: "pending" },
      database: { status: "pending" }
    }
  }

  // 1. Check environment variables — delegates to validateEnv() so this list
  //    stays in sync with lib/env-validation.ts automatically.
  try {
    const { isValid, missing } = validateEnv()

    log.debug("Environment check completed", { missingVars: missing.length });

    healthCheck.checks.environment = {
      status: isValid ? "healthy" : "unhealthy",
      missingVariables: missing,
      nodeEnv: process.env.NODE_ENV,
      details: {
        hasAuthUrl: !!process.env.AUTH_URL,
        hasAuthSecret: !!process.env.AUTH_SECRET,
        hasGoogleId: !!process.env.AUTH_GOOGLE_ID,
        hasGoogleSecret: !!process.env.AUTH_GOOGLE_SECRET,
        hasGcsBucket: !!process.env.GCS_BUCKET_NAME,
        // Database — one of three modes required (same logic as validateEnv)
        hasDatabaseUrl: !!process.env.DATABASE_URL,
        hasDbHost: !!process.env.DB_HOST,
        hasCloudSqlSocket: !!process.env.CLOUD_SQL_SOCKET_PATH,
        dbConfigured: !!process.env.DATABASE_URL || !!process.env.DB_HOST || !!process.env.CLOUD_SQL_SOCKET_PATH,
      }
    }
  } catch (error) {
    log.error("Environment check failed", error);
    healthCheck.checks.environment = {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error"
    }
  }

  // 2. Check authentication — gate on Google OIDC vars being present
  if (process.env.AUTH_SECRET && process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    try {
      const session = await getServerSession()
      log.debug("Authentication check completed", { hasSession: !!session });
      healthCheck.checks.authentication = {
        status: "healthy",
        hasSession: !!session,
        sessionUser: session?.email || "no active session",
        authConfigured: true
      }
    } catch (error) {
      log.error("Authentication check failed", error);
      healthCheck.checks.authentication = {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        hint: "Authentication system may not be properly configured"
      }
    }
  } else {
    healthCheck.checks.authentication = {
      status: "unhealthy",
      authConfigured: false,
      hint: "AUTH_SECRET and AUTH_GOOGLE_ID must be set"
    }
  }

  // 3. Check database connectivity
  // Supports: DATABASE_URL (direct), DB_HOST (TCP), CLOUD_SQL_SOCKET_PATH (Cloud Run)
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasDbHost = !!process.env.DB_HOST;
  const hasCloudSqlSocket = !!process.env.CLOUD_SQL_SOCKET_PATH;

  const connectionType = hasDatabaseUrl
    ? 'DATABASE_URL (direct)'
    : hasDbHost
      ? 'DB_HOST (TCP)'
      : hasCloudSqlSocket
        ? 'CLOUD_SQL_SOCKET_PATH (Cloud Run socket)'
        : null;

  if (connectionType) {
    try {
      const dbValidation = await validateDatabaseConnection()
      log.debug("Database check completed", { success: dbValidation.success });
      healthCheck.checks.database = {
        status: dbValidation.success ? "healthy" : "unhealthy",
        connectionType,
        ...dbValidation
      }
    } catch (error) {
      log.error("Database check failed", error);
      healthCheck.checks.database = {
        status: "error",
        connectionType,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: process.env.NODE_ENV !== 'production' ?
            error.stack?.split('\n').slice(0, 5).join('\n') : undefined
        } : "Unknown error"
      }
    }
  } else {
    healthCheck.checks.database = {
      status: "unhealthy",
      configured: false,
      hint: "No database connection configured. Set one of: DATABASE_URL, DB_HOST+DB_USER+DB_PASSWORD, or CLOUD_SQL_SOCKET_PATH+DB_USER+DB_PASSWORD"
    }
  }

  // 4. Overall health status
  const allHealthy = Object.values(healthCheck.checks).every(
    (check) => check.status === "healthy"
  )

  healthCheck.status = allHealthy ? "healthy" : "unhealthy"

  log.info("Health check completed", {
    status: healthCheck.status,
    environmentStatus: healthCheck.checks.environment.status,
    authStatus: healthCheck.checks.authentication.status,
    databaseStatus: healthCheck.checks.database.status
  });

  timer({ status: allHealthy ? "success" : "unhealthy" });

  // 5. Add diagnostic hints if unhealthy
  if (!allHealthy) {
    healthCheck.diagnostics = { hints: [] }

    if (healthCheck.checks.environment.status !== "healthy") {
      const missing = healthCheck.checks.environment.missingVariables ?? []
      healthCheck.diagnostics.hints.push(
        `Missing required env vars: ${missing.join(', ')}. Check Cloud Run service environment configuration.`
      )
    }

    if (healthCheck.checks.authentication.status !== "healthy") {
      healthCheck.diagnostics.hints.push(
        "AUTH_SECRET and both AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET must be set. Obtain OAuth 2.0 credentials from Google Cloud Console."
      )
    }

    if (healthCheck.checks.database.status !== "healthy") {
      if (!healthCheck.checks.database.configured) {
        healthCheck.diagnostics.hints.push(
          "Database not configured. Set DATABASE_URL (local dev), DB_HOST+DB_USER+DB_PASSWORD (TCP), or CLOUD_SQL_SOCKET_PATH+DB_USER+DB_PASSWORD (Cloud Run)."
        )
      } else {
        healthCheck.diagnostics.hints.push(
          "Database connectivity issue. Check connection credentials and that the Cloud SQL instance is running and accessible."
        )
      }
    }

    healthCheck.diagnostics.deploymentChecklist = [
      "1. Set AUTH_URL, AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, GCS_BUCKET_NAME in Cloud Run environment",
      "2. For Cloud Run: set CLOUD_SQL_SOCKET_PATH=/cloudsql/<project>:<region>:<instance> and DB_USER/DB_PASSWORD",
      "3. For local dev: set DATABASE_URL in .env.local",
      "4. Check Cloud Run logs for detailed error messages",
      "5. Verify Cloud SQL Auth Proxy is enabled or the Cloud Run service account has Cloud SQL Client role"
    ]
  }

  return NextResponse.json(
    healthCheck,
    {
      status: allHealthy ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      }
    }
  )
}
