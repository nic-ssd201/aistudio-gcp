# Local Development Environment

Issue #607 - Overhaul Local Development Environment

This guide explains how to set up and use the local development environment with PostgreSQL.

## Quick Start

```bash
# Start local PostgreSQL
npm run db:up

# Create test users (admin, staff, student)
npm run db:seed

# Start Next.js with local database
npm run dev:local
```

## Prerequisites

- Docker Desktop (or compatible Docker runtime)
- Node.js 22+
- npm or bun

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run db:up` | Start PostgreSQL container |
| `npm run db:down` | Stop PostgreSQL container |
| `npm run db:reset` | Reset database (destroys all data, re-runs migrations) |
| `npm run db:logs` | View PostgreSQL container logs |
| `npm run db:seed` | Create test users |
| `npm run db:studio` | Open Drizzle Studio to inspect database |
| `npm run db:psql` | Connect to database via psql CLI |
| `npm run db:migrate` | Run pending migrations |
| `npm run dev:local` | Start Next.js with local database |
| `npm run dev:docker` | Start full app + database in Docker |

## Environment Variables

Create a `.env.local` file with the following for local development:

```bash
# Database — Local PostgreSQL
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aistudio
DB_SSL=false

# Authentication — Google OIDC via NextAuth v5
# Create credentials at: https://console.cloud.google.com/apis/credentials
# Authorized redirect URI: http://localhost:3000/api/auth/callback/google
AUTH_URL=http://localhost:3000
AUTH_SECRET=dev-secret-change-in-prod   # openssl rand -base64 32
AUTH_GOOGLE_ID=your-google-client-id
AUTH_GOOGLE_SECRET=your-google-client-secret

# Storage — Google Cloud Storage
GCS_BUCKET=your-dev-bucket-name

# AI Providers (optional — fallback if not set in admin DB)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
```

## Test Users

After running `npm run db:seed`, the following test accounts are created:

| Email | Role | Access Level |
|-------|------|--------------|
| test@example.com | administrator | Full access |
| staff@example.com | staff | Staff tools |
| student@example.com | student | Basic access |

Sign in via Google OAuth at `http://localhost:3000`. The seed accounts must be signed in with real Google accounts sharing the same email address.

## Database Architecture

### Local vs AWS

| Environment | Database | SSL | Migration Method |
|-------------|----------|-----|------------------|
| Local Docker | PostgreSQL 16 Alpine | disabled (`DB_SSL=false`) | init-local.sh (auto on first start) |
| GCP Dev | Cloud SQL PostgreSQL | required | Lambda / migration runner (CDK deploy) |
| GCP Prod | Cloud SQL PostgreSQL | required | Lambda / migration runner (CDK deploy) |

### Migration Workflow

1. **Make schema changes** in `lib/db/schema/*.ts`

2. **Test locally** with push:
   ```bash
   npm run db:up
   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false npm run drizzle:push
   ```

3. **Generate migration** for AWS:
   ```bash
   npm run drizzle:generate
   npm run migration:prepare -- "description"
   ```

4. **Add to Lambda** in `infra/database/lambda/db-init-handler.ts`:
   ```typescript
   const MIGRATION_FILES = [
     // ... existing migrations
     '049-your-new-migration.sql'  // Add your migration
   ];
   ```

5. **Deploy to AWS**:
   ```bash
   cd infra && bunx cdk deploy AIStudio-DatabaseStack-Dev
   ```

## Docker Compose Services

### PostgreSQL (postgres)

- **Image**: postgres:16-alpine
- **Port**: 5432
- **Credentials**: postgres/postgres
- **Database**: aistudio
- **Volume**: postgres_data (persistent)

### Next.js App (app) - Optional

- **Port**: 3000
- **Hot reload**: Enabled via volume mounts
- **Environment**: Development mode

## Troubleshooting

### "Connection refused" when starting dev:local

Ensure PostgreSQL is running:
```bash
npm run db:up
docker ps  # Should show aistudio-postgres
```

### Database schema mismatch

Reset and re-run migrations:
```bash
npm run db:reset
npm run db:seed
```

### Migrations failed during init

Check the logs:
```bash
npm run db:logs
```

Common issues:
- Migration file not found: Ensure file exists in `infra/database/schema/`
- Syntax error: Check the SQL file for errors

### "SSL required" error

Ensure `DB_SSL=false` is set in your environment:
```bash
export DB_SSL=false
npm run dev:local
```

## Data Sync from GCP Dev (Advanced)

For syncing reference data (models, tools) from the GCP dev Cloud SQL instance:

```bash
export DEV_DB_HOST=your-cloud-sql-ip
export DEV_DB_USER=your_user
export DEV_DB_PASSWORD=your_password

bun run db:sync-dev
```

Note: User data is NOT synced for privacy. Use `bun run db:seed` for test users.

## Related Documentation

- [Drizzle Migration Guide](/docs/database/drizzle-migration-guide.md)
- [Drizzle Patterns](/docs/database/drizzle-patterns.md)
- [Database Architecture](/docs/ARCHITECTURE.md#database)
