/**
 * Database Migration Runner for Local Development
 * Issue #607 - Local Development Environment
 *
 * This script runs database migrations against the local PostgreSQL instance.
 * It mirrors the logic in the AWS Lambda db-init-handler but runs locally.
 *
 * Usage:
 *   bun run db:migrate          # Run all pending migrations
 *   npm run db:migrate          # Same with npm
 *   tsx scripts/db/run-migrations.ts  # Direct execution
 *
 * Environment Variables:
 *   DATABASE_URL - PostgreSQL connection string (preferred when set)
 *   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME - Fallback when
 *     DATABASE_URL is not set. Matches the env shape Cloud Run wires up
 *     for the web service so the same secret_key_ref + env block can be
 *     reused by the migration Cloud Run Job without a shell wrapper to
 *     hand-craft a URL.
 *   DB_SSL - Set to 'false' for local development without SSL
 */

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { scriptLogger as log } from "./script-logger";
import { MIGRATION_FILES, SCHEMA_DIR } from "./migration-manifest";

/**
 * Build a postgres connection URL from individual DB_* env vars, URL-encoding
 * each component so passwords with special characters (`:`, `@`, `/`, `?`, …)
 * don't break URL parsing. Returns null if the required pieces aren't set.
 */
function buildUrlFromDbEnv(): string | null {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  if (!host || !user || !password) return null;
  const port = process.env.DB_PORT || "5432";
  const database = process.env.DB_NAME || "aistudio";
  return (
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(database)}`
  );
}

// Resolution order:
//   1. DATABASE_URL (explicit override — used by local dev & CI).
//   2. DB_HOST/DB_USER/DB_PASSWORD/[DB_PORT]/[DB_NAME] (Cloud Run shape).
//   3. Local docker default — only viable when developing against db:up.
const DATABASE_URL =
  process.env.DATABASE_URL ||
  buildUrlFromDbEnv() ||
  "postgresql://postgres:postgres@localhost:5432/aistudio";
const sslEnabled = process.env.DB_SSL !== "false";

const schemaPath = path.join(process.cwd(), SCHEMA_DIR);

async function main(): Promise<void> {
  log.section("AI Studio - Database Migration Runner");
  log.info("Database", { url: DATABASE_URL.replace(/:\/\/.*@/, "://*****@") });
  log.info("SSL", { enabled: sslEnabled });

  const sql = postgres(DATABASE_URL, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    // Test connection
    log.info("Testing database connection...");
    await sql`SELECT 1`;
    log.success("Connection successful");

    // Ensure migration_log table exists
    await sql`
      CREATE TABLE IF NOT EXISTS migration_log (
        id SERIAL PRIMARY KEY,
        step_number INTEGER NOT NULL,
        description TEXT NOT NULL,
        sql_executed TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Get already-run migrations
    const completedMigrations = await sql`
      SELECT description FROM migration_log WHERE status = 'completed'
    `;
    const completedSet = new Set(completedMigrations.map((r) => r.description));

    log.info("Processing migrations...");

    let runCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const migrationFile of MIGRATION_FILES) {
      if (completedSet.has(migrationFile)) {
        log.debug(`SKIP: ${migrationFile} (already run)`);
        skipCount++;
        continue;
      }

      const filePath = path.join(schemaPath, migrationFile);

      if (!fs.existsSync(filePath)) {
        log.warn(`Migration file not found: ${migrationFile}`);
        continue;
      }

      log.info(`Running: ${migrationFile}`);
      const startTime = Date.now();

      try {
        const sqlContent = fs.readFileSync(filePath, "utf8");

        // Split and execute statements
        const statements = splitSqlStatements(sqlContent);

        for (const statement of statements) {
          const trimmed = statement.trim();
          if (!trimmed || trimmed === ";") continue;

          try {
            await sql.unsafe(trimmed);
          } catch (err: unknown) {
            const error = err as Error;
            // Ignore "already exists" errors for idempotency
            if (
              error.message?.includes("already exists") ||
              error.message?.includes("duplicate key")
            ) {
              // Expected for idempotent migrations
            } else {
              throw error;
            }
          }
        }

        // Record success
        const duration = Date.now() - startTime;
        await sql`
          INSERT INTO migration_log (step_number, description, sql_executed, status)
          SELECT COALESCE(MAX(step_number), 0) + 1, ${migrationFile}, 'File executed', 'completed'
          FROM migration_log
        `;

        log.success(`${migrationFile} (${duration}ms)`);
        runCount++;
      } catch (err: unknown) {
        const error = err as Error;
        log.fail(`${migrationFile}: ${error.message}`);
        failCount++;

        // Record failure
        await sql`
          INSERT INTO migration_log (step_number, description, sql_executed, status, error_message)
          SELECT COALESCE(MAX(step_number), 0) + 1, ${migrationFile}, 'File execution failed', 'failed', ${error.message}
          FROM migration_log
        `;

        throw error;
      }
    }

    log.section("Migration Summary");
    log.info("Results", {
      run: runCount,
      skipped: skipCount,
      failed: failCount,
      total: MIGRATION_FILES.length,
    });
  } finally {
    await sql.end();
  }
}

/**
 * Split SQL content into individual statements
 * Handles multi-line statements and preserves function/type definitions
 */
function splitSqlStatements(sqlContent: string): string[] {
  // Remove comments
  const withoutComments = sqlContent
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements: string[] = [];
  let currentStatement = "";
  let inBlock = false;

  const lines = withoutComments.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim().toUpperCase();

    // Check if entering a block
    if (
      trimmedLine.startsWith("CREATE TYPE") ||
      trimmedLine.startsWith("CREATE FUNCTION") ||
      trimmedLine.startsWith("CREATE OR REPLACE FUNCTION") ||
      trimmedLine.startsWith("DROP TYPE")
    ) {
      inBlock = true;
    }

    currentStatement += line + "\n";

    // Check if line ends with semicolon
    if (line.trim().endsWith(";")) {
      if (
        inBlock &&
        (trimmedLine === ");" ||
          trimmedLine.endsWith(");") ||
          trimmedLine.endsWith("' LANGUAGE PLPGSQL;"))
      ) {
        inBlock = false;
      }

      if (!inBlock) {
        statements.push(currentStatement.trim());
        currentStatement = "";
      }
    }
  }

  if (currentStatement.trim()) {
    statements.push(currentStatement.trim());
  }

  return statements;
}

main().catch((error) => {
  log.error("Migration failed", { error: error.message });
  process.exit(1);
});
