/**
 * Environment Variable Validation
 * Ensures all required environment variables are set before the application starts
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

  // Auth providers — at least one of Cognito or Google must be configured;
  // validated dynamically below rather than as individual required fields so
  // GCP-only (Google-only) and AWS-only (Cognito-only) deployments both pass.
  { name: 'AUTH_COGNITO_CLIENT_ID', required: false, description: 'AWS Cognito client ID' },
  { name: 'AUTH_COGNITO_CLIENT_SECRET', required: false, description: 'AWS Cognito client secret' },
  { name: 'AUTH_COGNITO_ISSUER', required: false, description: 'AWS Cognito issuer URL' },
  { name: 'AUTH_GOOGLE_ID', required: false, description: 'Google OAuth client ID (GCP migration)' },
  { name: 'AUTH_GOOGLE_SECRET', required: false, description: 'Google OAuth client secret (GCP migration)' },

  // Database — validated dynamically below; one of three connection modes is required:
  //   1. DATABASE_URL  (local dev, direct URL)
  //   2. DB_HOST + DB_USER + DB_PASSWORD  (AWS ECS / TCP)
  //   3. CLOUD_SQL_SOCKET_PATH + DB_USER + DB_PASSWORD  (GCP Cloud Run)
  { name: 'DATABASE_URL', required: false, description: 'PostgreSQL connection URL (local dev)' },
  { name: 'DB_HOST', required: false, description: 'Database hostname (AWS ECS / TCP)' },
  { name: 'CLOUD_SQL_SOCKET_PATH', required: false, description: 'Cloud SQL socket dir (GCP Cloud Run)' },
  { name: 'DB_USER', required: false, description: 'Database username' },
  { name: 'DB_PASSWORD', required: false, description: 'Database password' },
  { name: 'DB_NAME', required: false, description: 'Database name (defaults to aistudio)' },
  { name: 'DB_SSL', required: false, description: 'Enable SSL for TCP connections (defaults to true)' },

  // AWS Configuration — optional; not required for GCP-only deployments
  { name: 'NEXT_PUBLIC_AWS_REGION', required: false, description: 'AWS region (set for AWS deployments)' },
  { name: 'AWS_REGION', required: false, description: 'AWS region (runtime)' },
  { name: 'AWS_DEFAULT_REGION', required: false, description: 'AWS default region (runtime)' },

  // GCS / Storage
  { name: 'GCS_BUCKET_NAME', required: true, description: 'GCS bucket for document storage' },

  // AI Services
  { name: 'ANTHROPIC_API_KEY', required: false, description: 'Anthropic API key for Claude' },
  { name: 'OPENAI_API_KEY', required: false, description: 'OpenAI API key' },

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
 * Validates that all required environment variables are set
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
  
  // Auth provider: at least one of Cognito or Google must be configured.
  const hasCognito = !!process.env.AUTH_COGNITO_CLIENT_ID && !!process.env.AUTH_COGNITO_ISSUER;
  const hasGoogle = !!process.env.AUTH_GOOGLE_ID && !!process.env.AUTH_GOOGLE_SECRET;
  if (!hasCognito && !hasGoogle) {
    missing.push('AUTH_COGNITO_CLIENT_ID+AUTH_COGNITO_ISSUER or AUTH_GOOGLE_ID+AUTH_GOOGLE_SECRET (at least one auth provider required)');
  }
  // Partial Google config is caught at module load in auth.ts; flag it here too.
  if (process.env.AUTH_GOOGLE_ID && !process.env.AUTH_GOOGLE_SECRET) {
    missing.push('AUTH_GOOGLE_SECRET (required when AUTH_GOOGLE_ID is set)');
  }

  // Database: one of three connection modes must be configured.
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasTcpConfig = !!process.env.DB_HOST && !!process.env.DB_USER && !!process.env.DB_PASSWORD;
  const hasSocketConfig = !!process.env.CLOUD_SQL_SOCKET_PATH && !!process.env.DB_USER && !!process.env.DB_PASSWORD;
  if (!hasDatabaseUrl && !hasTcpConfig && !hasSocketConfig) {
    missing.push('DATABASE_URL, or DB_HOST+DB_USER+DB_PASSWORD, or CLOUD_SQL_SOCKET_PATH+DB_USER+DB_PASSWORD (database configuration required)');
  }
  
  // AWS region: warn on AWS deployments without region, but don't require for GCP.
  const isAwsDeployment = hasCognito || !!process.env.DB_HOST || !!process.env.AWS_REGION;
  if (isAwsDeployment && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION && !process.env.NEXT_PUBLIC_AWS_REGION) {
    warnings.push('AWS deployment detected but no AWS region configured (AWS_REGION / NEXT_PUBLIC_AWS_REGION)');
  }

  // Check for at least one AI API key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    warnings.push('No AI API keys configured. AI features will not work.');
  }
  
  return {
    isValid: missing.length === 0,
    missing,
    warnings
  };
}

/**
 * Validates environment variables and throws if validation fails
 * Use this in API routes and server components
 */
export function requireValidEnv(): void {
  const { isValid, missing, warnings } = validateEnv();
  
  if (!isValid) {
    throw new EnvironmentValidationError(missing, warnings);
  }
  
  // Console warnings in development (logger not available in Edge Runtime)
  if (process.env.NODE_ENV === 'development' && warnings.length > 0) {
    console.warn('Environment validation warnings:');
    for (const warning of warnings) console.warn(`  - ${warning}`);
  }
}

/**
 * Get a required environment variable or throw
 */
export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value
 */
export function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}