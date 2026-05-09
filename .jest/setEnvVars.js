process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test_db';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

// Required vars (validated by requireValidEnv() / validateEnv()).
// Tests that exercise instrumentation.ts or validateEnv() directly will fail
// at module load if these are absent — keep this list in sync with the
// `required: true` entries in lib/env-validation.ts.
process.env.AUTH_URL = 'http://localhost:3000';
process.env.AUTH_SECRET = 'test-auth-secret-for-jest-do-not-use-in-production';
process.env.GCS_BUCKET = 'test-gcs-bucket';
// Required by code that talks to Google Cloud Secret Manager (token-encryption,
// connector-service). The mocked SDK doesn't actually use this, but
// `getRequiredEnv('GCP_PROJECT_ID')` runs before the SDK call.
process.env.GCP_PROJECT_ID = 'test-project';
