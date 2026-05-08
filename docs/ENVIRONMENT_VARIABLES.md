# Environment Variables — SSD201 GCP Deployment

This document covers all environment variables required for the AI Studio
application running on **Google Cloud Platform** (Cloud Run + Cloud SQL).
The fork has replaced AWS Cognito with Google OIDC (via NextAuth v5) and
AWS RDS/S3 with Cloud SQL/GCS.

> **Auth source of truth:** `lib/env-validation.ts` — the `validateEnv()`
> function is the canonical required-vars list and is called by both
> `/api/health` and application startup.

---

## Required Variables

### Authentication — NextAuth v5 + Google OIDC

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `AUTH_URL` | Full URL where the app is hosted | `https://dev.yourdomain.com` | ✅ |
| `AUTH_SECRET` | Secret for NextAuth.js JWT encryption | `openssl rand -base64 32` | ✅ |
| `AUTH_GOOGLE_ID` | Google OAuth 2.0 client ID | From GCP Console → Credentials | ✅ |
| `AUTH_GOOGLE_SECRET` | Google OAuth 2.0 client secret | From GCP Console → Credentials | ✅ |

`AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` must both be set or both absent —
`validateEnv()` rejects partial configuration.

### Database — Cloud SQL (one mode required)

Three mutually exclusive modes; set exactly one:

| Mode | Variables | Use case |
|------|-----------|----------|
| **Direct URL** | `DATABASE_URL` | Local dev, simple deploys |
| **TCP** | `DB_HOST` + `DB_USER` + `DB_PASSWORD` | Cloud SQL via IP / VPN |
| **Unix socket** | `CLOUD_SQL_SOCKET_PATH` + `DB_USER` + `DB_PASSWORD` | Cloud Run (recommended) |

Optional tuning:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_NAME` | `aistudio` | Database name |
| `DB_PORT` | `5432` | TCP port (ignored for socket mode) |
| `DB_SSL` | `true` | Set `false` for local dev without TLS |
| `DB_MAX_CONNECTIONS` | `20` | Pool size per container |
| `DB_IDLE_TIMEOUT` | `20` | Seconds before idle connection is closed |
| `DB_CONNECT_TIMEOUT` | `10` | Connection timeout in seconds |
| `SQL_LOGGING` | `false` | Set `true` to log all queries (dev only) |

### Storage — Google Cloud Storage

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `GCS_BUCKET` | GCS bucket for document/file storage | `aistudio-dev-documents` | ✅ |
| `GCS_REGION` | Bucket region | `us-central1` | ❌ |

### Session

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_MAX_AGE` | `86400` (24 h) | JWT session lifetime in seconds. Must be a positive integer; non-numeric values fall back to the default. |
| `TOKEN_REFRESH_THRESHOLD_MS` | `300000` (5 min) | How many milliseconds before token expiry to proactively refresh. Minimum 60000 ms. Increase for deployments with long-running streaming paths (>5 min). |

#### Polling auth cache and role-change propagation

The polling auth layer caches authenticated user data (userId, roles) for up to
5 minutes (`TOKEN_REFRESH_THRESHOLD_MS`) to reduce database hits on polling
endpoints. When a role change is committed, `pollingSessionCache.invalidateUser()`
flushes the cache on the **current instance only**.

**Multi-instance staleness window:** On Cloud Run (or any deployment with N > 1
container instances), the other N−1 instances continue serving the previous role
set for up to 5 minutes until the cache TTL expires naturally. This is the
accepted trade-off for the polling-auth performance improvement.

**Operational implications:**

- **Normal role changes** (adding/removing non-privileged roles): the 5-minute
  window is acceptable for most use cases.
- **Security-sensitive demotions** (revoking admin access for a compromised
  account): do not rely on cache expiry alone. Rotate `AUTH_SECRET` to
  invalidate all active JWT sessions fleet-wide, or scale down to a single
  instance temporarily to guarantee immediate propagation.
- **Tracking:** A cross-instance invalidation signal (Pub/Sub-driven cache flush
  or a shared Redis cache) would eliminate the staleness window. This is tracked
  in issue #9 as a future improvement.

To monitor the window in practice, watch the `Google token refresh failed` and
`Skipping polling cache — session.iat absent` warn-rate in Cloud Logging. A
spike after a role change indicates instances still serving cached sessions.

---

## Email Notifications

The upstream application used AWS SQS + a Lambda `EmailNotificationStack` for
scheduled-execution result notifications. That stack was **removed in this fork**
as part of the Cognito/AWS removal.

**Current state:** Email notifications are a **no-op stub**.
`app/api/assistant-architect/execute/scheduled/route.ts` calls
`sendNotificationToQueue()`, which logs an info message and returns without
sending anything when `NOTIFICATION_QUEUE_URL` is unset (which it always is in
this fork). Users are not notified by email when scheduled executions complete.

**To wire up notifications on GCP:** Replace the stub with a Cloud Pub/Sub
publish call. Set `NOTIFICATION_QUEUE_URL` (or an equivalent GCP-specific env
var) to trigger the active path. This is tracked in the project backlog.

| Variable | Description | Required |
|----------|-------------|----------|
| `NOTIFICATION_QUEUE_URL` | (stub, unused) Legacy SQS URL — not consumed in this fork | ❌ |

---

## Optional / AI Provider Variables

AI provider API keys are managed through the database-first settings system.
These environment variables serve as fallbacks when database settings are not
configured.

| Variable | Description | Required |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | ❌ (fallback) |
| `OPENAI_API_KEY` | OpenAI API key | ❌ (fallback) |
| `GOOGLE_API_KEY` | Google AI / Gemini API key | ❌ (fallback) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key | ❌ (fallback) |
| `AZURE_OPENAI_RESOURCE_NAME` | Azure OpenAI resource name | ❌ (fallback) |

> In production, manage these through the admin interface at `/admin/settings`.
> The application checks the database first, then falls back to env vars.

---

## Local Development

See [docs/database/local-development.md](database/local-development.md) for
the full `.env.local` template.

Minimal local setup:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aistudio
DB_SSL=false
AUTH_URL=http://localhost:3000
AUTH_SECRET=dev-secret-change-in-prod
AUTH_GOOGLE_ID=<your-google-client-id>
AUTH_GOOGLE_SECRET=<your-google-client-secret>
GCS_BUCKET=<your-gcs-bucket>
```

---

## Cloud Run Deployment

Cloud Run with Cloud SQL (recommended socket mode):

```bash
CLOUD_SQL_SOCKET_PATH=/cloudsql/my-project:us-central1:my-instance
DB_USER=aistudio
DB_PASSWORD=<from Secret Manager>
DB_NAME=aistudio
AUTH_URL=https://app.yourdomain.com
AUTH_SECRET=<from Secret Manager>
AUTH_GOOGLE_ID=<from Secret Manager>
AUTH_GOOGLE_SECRET=<from Secret Manager>
GCS_BUCKET=aistudio-prod-documents
```

---

## Health Check

Use `/api/health` to verify configuration:

```bash
curl https://app.yourdomain.com/api/health | jq .checks.environment
```

The endpoint calls `validateEnv()` and reports which variables are missing.

---

## Troubleshooting

| Error | Likely cause | Fix |
|-------|-------------|-----|
| `"AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET are required"` | Google OAuth not configured | Add both vars |
| `"Database configuration not found"` | No DB mode set | Add `DATABASE_URL`, `DB_HOST`, or `CLOUD_SQL_SOCKET_PATH` |
| `"connect ECONNREFUSED"` | DB not running | Start Docker (`bun run db:up`) or check Cloud SQL proxy |
| `"SSL required"` | `DB_SSL` not set to false for local dev | Add `DB_SSL=false` |
| `CallbackRouteError` | OAuth redirect URI mismatch | Add `AUTH_URL` to Google Cloud Console authorized redirect URIs |

---

## Security Notes

1. **Never commit secrets** — use Secret Manager in production
2. **Rotate `AUTH_SECRET`** periodically (rotates all active sessions)
3. **`DB_SSL=false` is local dev only** — always use SSL in Cloud Run
4. **`SQL_LOGGING=true` logs query contents** — never enable in production
