/**
 * Next.js Instrumentation Hook
 *
 * Issue #603 - Implements graceful shutdown and connection pool warmup
 * for the postgres.js database driver migration.
 *
 * This file is automatically loaded by Next.js 15 during server startup.
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

/**
 * Graceful shutdown handler for SIGTERM/SIGINT signals
 *
 * ECS sends SIGTERM when stopping containers (with initProcessEnabled: true).
 * This ensures database connections are properly closed before exit.
 */
async function handleShutdown(signal: string): Promise<void> {
  // Dynamic import to avoid loading during build
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({ context: "instrumentation", operation: "shutdown" });

  log.info(`Received ${signal}, initiating graceful shutdown...`);

  try {
    const { closeDatabase } = await import("@/lib/db/drizzle-client");
    const { pollingSessionCache } = await import("@/lib/auth/polling-session-cache");

    await closeDatabase();
    // Destroy the polling session cache: clears the cleanup interval so
    // the timer does not hold the event loop open after the DB is closed.
    // Also ensures any future async teardown added to destroy() participates
    // in the shutdown window rather than being silently abandoned.
    pollingSessionCache.destroy();

    log.info("Graceful shutdown completed successfully");
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error("Error during graceful shutdown", { error: errorMessage });
    process.exit(1);
  }
}

/**
 * Warm up database connection pool on startup
 *
 * This avoids first-request latency spikes (100-500ms) by establishing
 * connections during server initialization instead of on first query.
 *
 * Note: Connection warmup is non-blocking and failures don't prevent startup.
 */
async function warmupConnectionPool(): Promise<void> {
  // Dynamic import to avoid loading during build
  const { createLogger } = await import("@/lib/logger");
  const log = createLogger({ context: "instrumentation", operation: "warmup" });

  try {
    const { validateDatabaseConnection } = await import("@/lib/db/drizzle-client");

    log.info("Warming up database connection pool...");
    const result = await validateDatabaseConnection();

    if (result.success) {
      log.info("Database connection pool warmed up successfully", {
        database: result.config.database,
        maxConnections: result.config.maxConnections,
      });
    } else {
      // Don't fail startup, but log warning for monitoring
      log.warn("Database connection warmup failed - connections will be established on first query", {
        error: result.error,
        database: result.config.database,
      });
    }
  } catch (error) {
    const { createLogger: createLoggerFallback } = await import("@/lib/logger");
    const fallbackLog = createLoggerFallback({ context: "instrumentation" });
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Don't fail startup on warmup errors
    fallbackLog.warn("Database connection warmup error - will retry on first query", {
      error: errorMessage,
    });
  }
}

/**
 * Next.js instrumentation register function
 *
 * Called once when the Next.js server starts. Used to:
 * 1. Register shutdown handlers for graceful connection cleanup
 * 2. Warm up the database connection pool to avoid cold start latency
 *
 * Only runs in Node.js runtime (not Edge runtime or during builds).
 */
export async function register(): Promise<void> {
  // Only run on server runtime, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Validate environment variables at startup so operator misconfiguration
    // (e.g. TOKEN_REFRESH_THRESHOLD_MS=5000, SESSION_MAX_AGE=abc) is surfaced
    // in server logs immediately, not silently ignored until a user hits an
    // affected code path.  requireValidEnv() throws on missing required vars
    // (hard failure) and emits console.warn for invalid-but-optional vars.
    // Dynamic import keeps this out of the Edge runtime and build paths.
    const { requireValidEnv } = await import("@/lib/env-validation");
    try {
      requireValidEnv();
    } catch (err) {
      // Log the validation error but do not re-throw: Next.js treats an
      // exception from register() as a fatal startup error and will refuse to
      // serve requests.  In environments where env vars are injected at runtime
      // (Cloud Run, Docker) the app should start and let the health endpoint
      // surface the missing vars rather than crashing the container immediately.
      // The missing vars will cause individual request handlers to fail loudly.
      const { createLogger } = await import("@/lib/logger");
      const log = createLogger({ context: "instrumentation", operation: "env-validation" });
      // ALERT: add a Cloud Logging filter on this log line to catch silent prod
      // misconfigurations before users do:
      //   resource.type="cloud_run_revision"
      //   jsonPayload.message="Environment validation failed at startup*"
      // A rolling deploy with a misconfigured revision will keep old instances
      // healthy while routing some requests to the broken one — the filter above
      // surfaces this before it escalates.
      log.error("Environment validation failed at startup — some features may not work", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Register shutdown handlers
    // Using once() to prevent multiple registrations in development
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));
    process.once("SIGINT", () => handleShutdown("SIGINT"));

    // Warm up connection pool (async, non-blocking)
    // Use setImmediate to not block server startup
    setImmediate(() => {
      // warmupConnectionPool already logs errors internally
      // Empty catch prevents unhandled rejection without redundant logging
      warmupConnectionPool().catch(() => {
        // Errors already logged in warmupConnectionPool
      });
    });

  }
}
