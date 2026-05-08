# Operations Guide

This guide covers ongoing operations, monitoring, and management for the GCP infrastructure provisioned by this project (SSD201 fork — Google OIDC auth, Cloud Run, Cloud SQL).

## Monitoring
- **CloudWatch / Cloud Logging:**
  - Cloud Run instances emit structured logs to Cloud Logging.
  - Set up log-based alerts for high error rates, auth failures, and latency spikes.

## Backups & Data Retention
- **Aurora / Cloud SQL:**
  - Automated backups are enabled (7 days for prod, 1 day for dev).
  - Snapshots can be created manually via the Cloud SQL console.
- **S3 / GCS:**
  - Versioning is enabled for the documents bucket.
  - Lifecycle policy archives old versions after 30 days.

## User Management
- **Google OIDC (NextAuth v5):** There is no Cognito user pool in this fork.
  - Users are provisioned on first sign-in via JIT provisioning (`lib/auth/resolve-user.ts`).
  - To manage users (roles, deactivation, deletion), use the admin UI at `/admin/users`.
  - Set `AUTH_GOOGLE_HD` to restrict sign-in to a specific Google Workspace domain (see below).

## Cost Tracking
- All resources are tagged with `Environment`, `Project`, and `Owner` for cost allocation.
- Review GCP billing reports for usage and cost breakdowns.

## Security & Compliance
- **Google OAuth client IDs** are stored as environment variables (Cloud Run secrets); never hardcode them.
- **Google OAuth client secrets** are stored in GCP Secret Manager and injected at runtime.
- Principle of least privilege: IAM roles grant only required access.
- Cloud SQL credentials are never exposed; use Secret Manager and Cloud SQL Auth Proxy.

## Secrets Management
- All secrets (Google OAuth client secrets, database passwords) are managed in GCP Secret Manager.
- **Do not store public config (like OAuth client IDs) as secrets.**
- Rotate secrets regularly and update Cloud Run service environment variables as needed.

## Troubleshooting
- If Google sign-in fails, check:
  - `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are correctly set in Cloud Run environment.
  - The OAuth redirect URI in Google Cloud Console matches the deployed `AUTH_URL`.
  - `AUTH_GOOGLE_HD` is set to the correct Workspace domain (if domain restriction is enabled).
- If Cloud Run deployment fails, check Cloud Build logs and verify all required env vars are set.
- For missing secrets, create them in GCP Secret Manager and grant the Cloud Run service account access.

## Google Sign-In Domain Restriction — AUTH_GOOGLE_HD (Required in Production)

**`AUTH_GOOGLE_HD` is required in production.** The application will refuse to start without it.

Without domain restriction, any Google account (personal Gmail, other Workspace domains) can sign
in and will be **automatically provisioned** as a new user via JIT provisioning in
`lib/auth/resolve-user.ts`. For a K-12 deployment this is a real exposure — `2026@gmail.com`
and personal accounts would be auto-provisioned with a default student role.

### For Workspace-restricted deployments (recommended for K-12)

```bash
# .env (production)
AUTH_GOOGLE_HD=your-district.k12.example.com   # restricts to this Workspace domain at the IdP level
```

Google's OAuth `hd` parameter causes Google to reject sign-in attempts from accounts outside the
specified hosted domain *before* they reach the application — the user sees a Google-side error,
not an application error. This is the strongest gate available.

### For explicitly open deployments (any Google account may sign in)

```bash
# .env (production)
AUTH_GOOGLE_HD=OPEN   # explicitly allows any Google account (JIT-provisions all sign-ins)
```

The sentinel value `OPEN` satisfies the startup requirement while making the open-access policy
visible in configuration. Any Google account will be JIT-provisioned on first sign-in.

**Note**: `AUTH_GOOGLE_HD` restricts sign-in but does not affect users who are already provisioned.
To remove a provisioned user's access, use the admin user-management UI to delete or deactivate
their account.

## Polling Session Cache — Role Revocation Behavior (GCP Deployment)

The polling session cache (`lib/auth/polling-session-cache.ts`) is an in-process
cache that reduces auth overhead from ~500 ms to ~5 ms per request for long-poll
endpoints. Each Cloud Run instance maintains its own cache with a 5-minute TTL.

### Role revocation latency on multi-instance deployments

When an admin demotes or revokes a user's role via the admin UI:

1. The `updateUser` action calls `pollingSessionCache.invalidateUser(sub)` on the
   instance handling the admin request — that instance's cache is flushed immediately.
2. **Other instances are not notified** — they continue serving the old roles for up
   to 5 minutes (the cache TTL).

**Impact**: On Cloud Run with N > 1 instances, role revocation is not instant.
A demoted user may retain access for up to 5 minutes on instances that did not
handle the admin request.

**This is an accepted trade-off** for the polling-auth performance improvement.
A cross-instance invalidation mechanism (e.g. Cloud Pub/Sub → per-instance flush
endpoint) would close the window if sub-5-minute revocation becomes a hard requirement.

**Mitigation for urgent revocations**: set `POLLING_SESSION_CACHE_MAX_AGE=0` to
disable the cache entirely, or scale Cloud Run down to 1 instance temporarily.
The application functions correctly with the cache disabled — only polling
performance is affected.

## Disaster Recovery
- Restore RDS from automated or manual snapshots as needed.
- S3 versioning allows recovery of deleted/overwritten documents within the retention window.
- Amplify: redeploy frontend from GitHub

## Updates & Maintenance
- Update infrastructure via CDK and redeploy as needed.
- Review CloudFormation stack events for errors or drift.

For deployment instructions, see `DEPLOYMENT.md` (in this directory). For development, see `../DEVELOPER_GUIDE.md` (in the root directory). 