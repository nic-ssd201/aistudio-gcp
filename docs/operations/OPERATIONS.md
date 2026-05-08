# Operations Guide

This guide covers ongoing operations, monitoring, and management for the AWS infrastructure provisioned by this project.

## Monitoring
- **CloudWatch:**
  - All AWS resources emit logs and metrics to CloudWatch.
  - Set up CloudWatch Alarms for RDS, S3, and Cognito as needed (e.g., high error rates, storage thresholds).
- **Amplify:**
  - Monitor build and deployment status in the AWS Amplify Console.

## Backups & Data Retention
- **Aurora (RDS):**
  - Automated backups are enabled (7 days for prod, 1 day for dev).
  - Snapshots can be created manually via the RDS console.
  - Multi-AZ is enabled for production for high availability.
- **S3:**
  - Versioning is enabled for the documents bucket.
  - Lifecycle policy deletes old versions after 30 days.

## User Management
- **Cognito:**
  - Manage users and groups in the AWS Cognito Console.
  - Federated users (Google) are managed via Cognito.
  - User Pool settings (password policy, MFA, etc.) can be updated in the console or via CDK.

## Cost Tracking
- All resources are tagged with `Environment`, `Project`, and `Owner` for cost allocation.
- Activate these tags as Cost Allocation Tags in the AWS Billing console.
- Review AWS Cost Explorer for usage and cost breakdowns.

## Security & Compliance
- **Google OAuth client IDs are public and provided as CloudFormation parameters at deploy time. Never store client IDs in Secrets Manager or hardcode them.**
- **Google OAuth client secrets and GitHub tokens are stored in AWS Secrets Manager.**
- Principle of least privilege: IAM roles/policies grant only required access
- S3 buckets are private, encrypted, and block public access
- RDS credentials are never exposed; use Secrets Manager and RDS Proxy

## Secrets Management
- All secrets (Google OAuth client secrets, GitHub tokens) are managed in AWS Secrets Manager
- **Do not store public config (like OAuth client IDs) as secrets**
- Rotate secrets regularly and update stack parameters as needed

## Troubleshooting
- If Cognito Google login fails, check:
  - The correct client ID was provided as a parameter at deploy time
  - The client secret in Secrets Manager matches the Google Cloud Console value
  - Redirect URIs in Google Cloud Console match the deployed environment
- If stack deployment fails due to missing parameters, provide the required client ID(s) with `--parameters`
- For missing secrets, create them in AWS Secrets Manager as documented in `DEPLOYMENT.md` (in this directory)

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