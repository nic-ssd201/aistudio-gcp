/**
 * Environment Variable Validation — SSD201 GCP deployment
 *
 * Validates all required environment variables before the application starts.
 * Auth: Google OIDC only (no Cognito / AWS).
 * Database: one of DATABASE_URL | TCP | Cloud SQL socket.
 * Storage: GCS.
 */

// Logger is not imported to maintain compatibility with Edge Runtime and client-side code

interface EnvVar {
  name: string;
  required: boolean;
  description?: string;
}

const ENV_VARS: EnvVar[] = [
  // Authentication — always required
  { name: 'AUTH_URL', required: true, description: 'NextAuth base URL' },
  { name: 'AUTH_SECRET', required: true, description: 'NextAuth secret for JWT signing' },

  // Google OIDC — both are required, but `required: false` here is intentional:
  // pair-level validation is handled as a group below (see "Google OIDC" block
  // in validateEnv) so the per-field loop does not add them individually to
  // `missing[]` before the pair check runs (which would produce duplicate entries).
  { name: 'AUTH_GOOGLE_ID', required: false, description: 'Google OAuth client ID' },
  { name: 'AUTH_GOOGLE_SECRET', required: false, description: 'Google OAuth client secret' },

  // Database — one of three modes required; validated dynamically below:
  //   1. DATABASE_URL  (local dev / direct URL)
  //   2. DB_HOST + DB_USER + DB_PASSWORD  (TCP / Cloud SQL via IP)
  //   3. CLOUD_SQL_SOCKET_PATH + DB_USER + DB_PASSWORD  (Cloud Run Unix socket)
  { name: 'DATABASE_URL', required: false, description: 'PostgreSQL connection URL (local dev)' },
  { name: 'DB_HOST', required: false, description: 'Database hostname (TCP connection)' },
  { name: 'CLOUD_SQL_SOCKET_PATH', required: false, description: 'Cloud SQL socket dir (Cloud Run)' },
  { name: 'DB_USER', required: false, description: 'Database username' },
  { name: 'DB_PASSWORD', required: false, description: 'Database password' },
  { name: 'DB_NAME', required: false, description: 'Database name (defaults to aistudio)' },
  { name: 'DB_SSL', required: false, description: 'Enable SSL for TCP connections (defaults to true)' },
  { name: 'DB_PREPARE', required: false, description: 'Enable prepared statements (defaults to true; set false for PgBouncer transaction-mode pooling)' },

  // GCP / Storage
  // required:false — only needed when MCP connectors use Secret Manager;
  // getRequiredEnv('GCP_PROJECT_ID') in connector-service.ts fails-loud at
  // request time if MCP is attempted without it.
  { name: 'GCP_PROJECT_ID', required: false, description: 'GCP project ID (required for MCP connector Secret Manager access)' },
  { name: 'GCS_BUCKET', required: true, description: 'GCS bucket for document storage' },

  // AI Services
  { name: 'ANTHROPIC_API_KEY', required: false, description: 'Anthropic API key for Claude' },
  { name: 'OPENAI_API_KEY', required: false, description: 'OpenAI API key' },

  // Session / Token behaviour (optional overrides)
  { name: 'SESSION_MAX_AGE', required: false, description: 'Session lifetime in seconds (default: 86400 / 24 h)' },
  { name: 'TOKEN_REFRESH_THRESHOLD_MS', required: false, description: 'Access-token refresh look-ahead in ms (default: 300 000 / 5 min; floor: 60 000)' },

  // Application
  { name: 'NODE_ENV', required: false, description: 'Node environment (development/production)' },
];

export class EnvironmentValidationError extends Error {
  constructor(public missingVars: string[], public warnings: string[]) {
    super(`Missing required environment variables: ${missingVars.join(', ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Validates that all required environment variables are set.
 * @throws {EnvironmentValidationError} if required variables are missing
 */
export function validateEnv(): { isValid: boolean; missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.name];
    if (envVar.required && !value) {
      missing.push(envVar.name);
    } else if (!envVar.required && !value) {
      warnings.push(`Optional variable ${envVar.name} is not set${envVar.description ? ` (${envVar.description})` : ''}`);
    }
  }

  // Google OIDC: both ID and secret must be set together.
  // Trim whitespace before the truthiness check: a value of '  ' (stray spaces)
  // would pass !!value but fail at runtime with an "invalid_client" error from
  // Google — making the problem harder to debug than a startup validation failure.
  const hasGoogleId = !!(process.env.AUTH_GOOGLE_ID?.trim());
  const hasGoogleSecret = !!(process.env.AUTH_GOOGLE_SECRET?.trim());

  if (hasGoogleId && !hasGoogleSecret) {
    missing.push('AUTH_GOOGLE_SECRET (required when AUTH_GOOGLE_ID is set)');
  } else if (!hasGoogleId && hasGoogleSecret) {
    missing.push('AUTH_GOOGLE_ID (required when AUTH_GOOGLE_SECRET is set)');
  } else if (!hasGoogleId && !hasGoogleSecret) {
    missing.push('AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are required');
  }

  // Database: one of three connection modes must be configured.
  // Trim whitespace for the same reason as the Google credentials above: a
  // stray-space value passes !!value but would fail at connection time.
  const hasDatabaseUrl = !!(process.env.DATABASE_URL?.trim());
  const hasTcpConfig = !!(process.env.DB_HOST?.trim()) && !!(process.env.DB_USER?.trim()) && !!(process.env.DB_PASSWORD?.trim());
  const hasSocketConfig = !!(process.env.CLOUD_SQL_SOCKET_PATH?.trim()) && !!(process.env.DB_USER?.trim()) && !!(process.env.DB_PASSWORD?.trim());

  if (!hasDatabaseUrl && !hasTcpConfig && !hasSocketConfig) {
    missing.push('DATABASE_URL, or DB_HOST+DB_USER+DB_PASSWORD, or CLOUD_SQL_SOCKET_PATH+DB_USER+DB_PASSWORD (database configuration required)');
  }

  // SESSION_MAX_AGE: warn at startup when the value is set but will be silently
  // ignored (non-numeric or non-positive) — mirrors the TOKEN_REFRESH_THRESHOLD_MS warning.
  // Also warn on suspiciously short values (< 600 s / 10 min): a 1-minute session
  // lifetime is almost certainly a misconfiguration (e.g. seconds confused with
  // minutes) — flag it so the operator sees the effective value at deploy time.
  const SESSION_MAX_AGE_SOFT_FLOOR = 600; // 10 minutes
  const sessionMaxAgeRaw = process.env.SESSION_MAX_AGE;
  if (sessionMaxAgeRaw !== undefined && sessionMaxAgeRaw !== '') {
    const sessionMaxAge = Number.parseInt(sessionMaxAgeRaw, 10);
    if (!Number.isFinite(sessionMaxAge) || sessionMaxAge <= 0) {
      warnings.push(
        `SESSION_MAX_AGE="${sessionMaxAgeRaw}" is not a positive integer and will be ignored — effective value is 86400 s (24 h).`
      );
    } else if (sessionMaxAge < SESSION_MAX_AGE_SOFT_FLOOR) {
      warnings.push(
        `SESSION_MAX_AGE="${sessionMaxAgeRaw}" is unusually short (< ${SESSION_MAX_AGE_SOFT_FLOOR} s / 10 min) — verify this is intentional.`
      );
    }
  }

  // TOKEN_REFRESH_THRESHOLD_MS: warn at startup when the value is set but rejected
  // by the 60 000 ms floor so operators discover misconfiguration at deploy time.
  // Parsing rules are centralised in lib/auth/token-refresh-config.ts (getRefreshThresholdMs);
  // this block only needs to detect the "value was provided but invalid" case for the warning.
  const thresholdRaw = process.env.TOKEN_REFRESH_THRESHOLD_MS;
  if (thresholdRaw !== undefined && thresholdRaw !== '') {
    const thresholdMs = Number.parseInt(thresholdRaw, 10);
    if (!Number.isFinite(thresholdMs) || thresholdMs < 60_000) {
      warnings.push(
        `TOKEN_REFRESH_THRESHOLD_MS="${thresholdRaw}" is below the 60 000 ms floor and will be ignored — effective value is 300 000 ms (5 min).`
      );
    } else if (thresholdMs >= 1_800_000) {
      // An upper-bound warning: with TOKEN_REFRESH_THRESHOLD_MS >= 1 800 000 ms
      // (30 min), MIN_EXPIRES_IN in refresh-google-token.ts would reach 1800 s
      // (the runtime ceiling) and every Google token refresh response
      // (expires_in: 3600) would pass the check — but just barely.  At
      // >= 3 600 000 ms (1 h) it would fail every response silently.  Warn early
      // so operators discover the misconfiguration at startup, not at user-logout time.
      warnings.push(
        `TOKEN_REFRESH_THRESHOLD_MS="${thresholdRaw}" (${Math.round(thresholdMs / 60_000)} min) is unusually high — values ≥ 1 800 000 ms approach Google's 3 600 s token lifetime and may cause every token refresh to fail. Verify this is intentional.`
      );
    }
  }

  // AUTH_GOOGLE_FORCE_CONSENT: warn when set to an unrecognised value.
  // Normalise to lowercase so "False" / "FALSE" are accepted alongside "false".
  const forceConsent = process.env.AUTH_GOOGLE_FORCE_CONSENT;
  const forceConsentNorm = forceConsent?.toLowerCase();
  if (forceConsentNorm !== undefined && forceConsentNorm !== '' && forceConsentNorm !== 'true' && forceConsentNorm !== 'false') {
    warnings.push(
      `AUTH_GOOGLE_FORCE_CONSENT="${forceConsent}" is not recognised — expected "true" or "false". Defaulting to "true" (consent prompt).`
    );
  }

  // AI: warn if no keys configured.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    warnings.push('No AI API keys configured. AI features will not work.');
  }

  return { isValid: missing.length === 0, missing, warnings };
}

/**
 * Validates environment variables and throws if validation fails.
 * Use this in API routes and server components.
 */
export function requireValidEnv(): void {
  const { isValid, missing, warnings } = validateEnv();

  if (!isValid) {
    throw new EnvironmentValidationError(missing, warnings);
  }

  // Emit warnings in all environments except 'test' so operators see them in
  // staging and production deployment logs — not just local dev sessions.
  // 'test' is excluded to keep Jest output clean.
  if (process.env.NODE_ENV !== 'test' && warnings.length > 0) {
    console.warn('Environment validation warnings:'); // eslint-disable-line no-console -- Edge-runtime compatible; @/lib/logger unavailable here
    for (const warning of warnings) console.warn(`  - ${warning}`); // eslint-disable-line no-console -- same reason
  }
}

/** Get a required environment variable or throw. */
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/** Get an optional environment variable with a default value. */
export function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}
