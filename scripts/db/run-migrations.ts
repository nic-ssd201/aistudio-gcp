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
import {
  INITIAL_SETUP_FILES,
  MIGRATION_FILES,
  SCHEMA_DIR,
} from "./migration-manifest";

/**
 * Build a postgres.js connection config object from individual DB_* env vars.
 * Returns null if the required pieces aren't set, leaving the caller to fall
 * back to DATABASE_URL or the local-dev default.
 *
 * Why an object instead of constructing a postgresql:// URL string and parsing
 * it back? postgres.js running under bun in a Cloud Run container rejected our
 * URL with "cannot be parsed as a URL" even when Node's URL constructor (and
 * the postgres.js parser locally) accepted the same string. Avoiding URL
 * parsing entirely sidesteps any whitespace / encoding / parser-strictness
 * gotchas in the Secret Manager → env var → postgres.js handoff.
 */
function buildPostgresOptionsFromDbEnv(): Record<string, unknown> | null {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number.parseInt(process.env.DB_PORT || "5432", 10),
    user,
    password,
    database: process.env.DB_NAME || "aistudio",
  };
}

// Resolution order:
//   1. DATABASE_URL (explicit override — used by local dev & CI).
//   2. DB_HOST/DB_USER/DB_PASSWORD/[DB_PORT]/[DB_NAME] (Cloud Run shape).
//   3. Local docker default — only viable when developing against db:up.
const dbOptionsFromEnv = buildPostgresOptionsFromDbEnv();
const DATABASE_URL =
  process.env.DATABASE_URL ||
  (dbOptionsFromEnv ? null : "postgresql://postgres:postgres@localhost:5432/aistudio");
const sslEnabled = process.env.DB_SSL !== "false";

const schemaPath = path.join(process.cwd(), SCHEMA_DIR);

async function main(): Promise<void> {
  log.section("AI Studio - Database Migration Runner");

  // Common pool/SSL options applied regardless of which connection mode wins.
  const commonOpts = {
    ssl: sslEnabled ? ("require" as const) : (false as const),
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  };

  // Pick connection mode by precedence:
  //   1. dbOptionsFromEnv (DB_HOST/USER/PASSWORD/...) — preferred in Cloud Run.
  //   2. DATABASE_URL string — local dev & CI.
  // Object form skips URL parsing entirely, which we need because postgres.js
  // under bun rejected our URL with "cannot be parsed as a URL" even when the
  // same string parsed cleanly with Node's URL constructor locally.
  let sql: ReturnType<typeof postgres>;
  if (dbOptionsFromEnv) {
    log.info("Database (object mode)", {
      host: String(dbOptionsFromEnv.host),
      port: String(dbOptionsFromEnv.port),
      user: String(dbOptionsFromEnv.user),
      database: String(dbOptionsFromEnv.database),
    });
    log.info("SSL", { enabled: sslEnabled });
    sql = postgres({ ...dbOptionsFromEnv, ...commonOpts });
  } else if (DATABASE_URL) {
    log.info("Database (URL mode)", {
      url: DATABASE_URL.replace(/:\/\/.*@/, "://*****@"),
    });
    log.info("SSL", { enabled: sslEnabled });
    sql = postgres(DATABASE_URL, commonOpts);
  } else {
    throw new Error(
      "No database connection configured. Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD."
    );
  }

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

    // Apply INITIAL_SETUP_FILES (001-005, the immutable baseline schema)
    // before incremental migrations (010+). The AWS Lambda migrator did this
    // via a separate db-init-handler; this Node-side runner had been skipping
    // it, which left a fresh DB unable to apply 010-knowledge-repositories.sql
    // because it references the `users` table created in 002-tables.sql.
    //
    // Both lists go through the same loop so the migration_log dedup applies
    // uniformly — re-running on an already-set-up DB is a no-op.
    const allFiles = [...INITIAL_SETUP_FILES, ...MIGRATION_FILES];
    for (const migrationFile of allFiles) {
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
      total: INITIAL_SETUP_FILES.length + MIGRATION_FILES.length,
    });
  } finally {
    await sql.end();
  }
}

/**
 * Split SQL content into individual statements.
 *
 * Honors PostgreSQL syntax that the previous heuristic splitter (line-based,
 * "is this a CREATE FUNCTION line?") got wrong:
 *   - dollar-quoted strings:  $$ … $$  and  $tag$ … $tag$
 *   - single-quoted strings:  '…' (with '' escape)
 *   - line comments:          -- to end of line
 *   - block comments:         /* … *​/
 *
 * Inside any of those, a `;` is literal text, not a statement terminator.
 * We previously failed on 017-add-user-roles-updated-at.sql because the
 * runner saw `BEGIN; … END;` inside a `DO $$ … $$;` block and chopped the
 * function body in half.
 *
 * Implementation: a small character-by-character scanner. Not a full SQL
 * parser, but covers the lexical features that affect statement boundaries.
 */
function splitSqlStatements(sqlContent: string): string[] {
  const statements: string[] = [];
  let buf = "";
  let i = 0;

  // Mutually exclusive states (only one is true at a time):
  let inLineComment = false;        // -- … \n
  let inBlockComment = false;       // /* … */
  let inSingleQuote = false;        // '…'  (PG escapes '' as literal ')
  let dollarTag: string | null = null; // $tag$ … $tag$  (null when not inside)

  const len = sqlContent.length;
  while (i < len) {
    const c = sqlContent[i];
    const next = i + 1 < len ? sqlContent[i + 1] : "";

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      buf += c;
      i++;
      continue;
    }

    if (inBlockComment) {
      if (c === "*" && next === "/") {
        buf += "*/";
        inBlockComment = false;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (dollarTag !== null) {
      // Inside a dollar-quoted string: look for the matching closing tag.
      const close = `$${dollarTag}$`;
      if (sqlContent.startsWith(close, i)) {
        buf += close;
        dollarTag = null;
        i += close.length;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (inSingleQuote) {
      // PG escapes '' as a literal apostrophe inside the same string.
      if (c === "'" && next === "'") {
        buf += "''";
        i += 2;
        continue;
      }
      if (c === "'") {
        buf += "'";
        inSingleQuote = false;
        i++;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // Outside any string/comment — look for state transitions or `;`.
    if (c === "-" && next === "-") {
      inLineComment = true;
      buf += "--";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      buf += "/*";
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      buf += "'";
      i++;
      continue;
    }
    if (c === "$") {
      // Try to match $tag$ where tag is empty or [A-Za-z_][A-Za-z0-9_]*.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlContent.slice(i));
      if (m) {
        dollarTag = m[1] ?? "";
        buf += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === ";") {
      buf += ";";
      const stmt = buf.trim();
      if (stmt && stmt !== ";") statements.push(stmt);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);

  return statements;
}

main().catch((error) => {
  log.error("Migration failed", { error: error.message });
  process.exit(1);
});
