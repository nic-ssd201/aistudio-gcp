# AI Studio — GCP Deployment Guide

Audience: engineer or agent (Patch/Sonnet) standing up a new environment from scratch.
This is a **greenfield** deployment — no AWS data exists, no migration required.

Authoritative plan: [`aistudio-gcp-migration-plan.md`](../../../.openclaw/workspace/aistudio-gcp-migration-plan.md) (§§4–10)
Terraform spec: [`specs/terraform-arch.md`](../../../.openclaw/workspace/specs/terraform-arch.md)
FERPA controls: [`specs/ferpa-controls.md`](../../../.openclaw/workspace/specs/ferpa-controls.md)
Operator runbook: [`.openclaw/workspace/aistudio-runbook.md`](../../../.openclaw/workspace/aistudio-runbook.md)

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment Structure](#2-environment-structure)
3. [First-Time Bootstrap](#3-first-time-bootstrap)
4. [Per-Environment Deploy](#4-per-environment-deploy)
5. [Secrets & Config](#5-secrets--config)
6. [Post-Deploy Verification](#6-post-deploy-verification)
7. [Rollback](#7-rollback)
8. [Known Quirks](#8-known-quirks)
9. [Troubleshooting Index](#9-troubleshooting-index)

---

## 1. Prerequisites

### GCP Access
- GCP Organization access: folder `SSD/Engineering/AIStudio/` must already exist, or you need Org Admin rights to create it.
- Billing account linked — confirm with Nic before creating projects (see open question §12.1 of the plan).
- `resourcemanager.projects.create` permission scoped to the `AIStudio/` folder.

### Local Tools

```bash
gcloud --version          # >= 460.x; install via https://cloud.google.com/sdk/docs/install
terraform --version       # >= 1.7.0; install via https://developer.hashicorp.com/terraform/install
bun --version             # >= 1.1; for running aistudio locally
docker --version          # for container builds
```

Authenticate gcloud:

```bash
gcloud auth login
gcloud auth application-default login
```

### Required GCP APIs

Enable these before running any Terraform. They must be enabled in **each project** (`aistudio-dev`, `aistudio-staging`, `aistudio-prod`, `aistudio-shared`):

```bash
PROJ=TBD:aistudio-dev   # repeat for each project

gcloud services enable \
  run.googleapis.com \
  alloydb.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  cloudkms.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  artifactregistry.googleapis.com \
  identitytoolkit.googleapis.com \
  aiplatform.googleapis.com \
  dlp.googleapis.com \
  dns.googleapis.com \
  certificatemanager.googleapis.com \
  cloudscheduler.googleapis.com \
  eventarc.googleapis.com \
  cloudtrace.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  accesscontextmanager.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  --project="${PROJ}"
```

### Vertex AI Claude Quota (H2 — file immediately)

Claude-on-Vertex requires an explicit quota request in `us-west1`. This often takes days to weeks.
**File this on Day 0** before anything else. See plan §8.4 (H2 is the long pole).

```bash
# Confirm what's currently enabled:
gcloud ai models list --region=us-west1 --project=TBD:aistudio-prod
```

TBD: Claude model IDs confirmed for district quota (e.g., `claude-3-5-sonnet-v2@20241022`, `claude-3-7-sonnet@20250219`).

---

## 2. Environment Structure

### Projects

| Project | Purpose | Notes |
|---------|---------|-------|
| `aistudio-shared` | Terraform state, Artifact Registry, WIF pool, org-wide log sink | Run-once bootstrap |
| `aistudio-dev` | Development environment | Scale-to-zero, AlloyDB auto-pause, min-instances=0 |
| `aistudio-staging` | Staging environment | Matches prod config; E2E smoke tests run here |
| `aistudio-prod` | Production | min-instances=1, CPU-always-on, VPC-SC enforced |

All projects live under folder `SSD/Engineering/AIStudio/`.

### Naming Convention

All named GCP resources follow `aistudio-<env>-<resource>` (e.g., `aistudio-prod-web`, `aistudio-dev-alloydb`).
Resource Manager tags on everything: `aistudio/environment=<env>`, `aistudio/managed-by=terraform`.

### Terraform Layout

```
aistudio/infra-gcp/
├── env/dev/          ← per-env composition
├── env/staging/
├── env/prod/
├── modules/bootstrap/
├── modules/network/
├── modules/vpc-sc/
├── modules/iam/
├── modules/kms/
├── modules/alloydb/
├── modules/cloud-run-web/
├── modules/cloud-run-job/
├── modules/storage/
├── modules/secrets/
├── modules/identity-platform/
├── modules/vertex/
├── modules/dlp/
├── modules/observability/
├── modules/scheduler/
└── modules/lb/
```

Full module contracts: see [terraform-arch.md §3](../../../.openclaw/workspace/specs/terraform-arch.md).

---

## 3. First-Time Bootstrap

This section runs **once per org**. It creates the shared state bucket, Artifact Registry, and WIF pool.
Subsequent deployments use the remote state bucket created here.

### 3.1 Manual pre-steps (human: Nic)

1. Create GCP folder `SSD/Engineering/AIStudio/` in the org console.
2. Create project `aistudio-shared` under that folder with billing linked.
3. Enable the APIs listed in §1 on `aistudio-shared`.
4. Create the Terraform runner service account manually (chicken-and-egg):

```bash
gcloud iam service-accounts create terraform-runner \
  --display-name="Terraform Runner" \
  --project=TBD:aistudio-shared

# Grant it roles in aistudio-shared
gcloud projects add-iam-policy-binding TBD:aistudio-shared \
  --member="serviceAccount:terraform-runner@TBD:aistudio-shared.iam.gserviceaccount.com" \
  --role="roles/owner"
```

TBD: `aistudio-shared` project ID (post-creation).

### 3.2 Apply the `bootstrap` module

```bash
cd aistudio/infra-gcp/modules/bootstrap

# Set required vars
cat > bootstrap.auto.tfvars <<EOF
org_id                 = "TBD:GCP_ORG_ID"
billing_account        = "TBD:BILLING_ACCOUNT_ID"
state_bucket_name      = "aistudio-terraform-state"
state_bucket_location  = "us-west1"
github_repo            = "psd401/aistudio"
openclaw_local_issuer  = "TBD:OPENCLAW_OIDC_ISSUER"
EOF

terraform init
terraform plan -out=bootstrap.tfplan
terraform apply bootstrap.tfplan
```

Bootstrap creates:
- GCS state bucket `aistudio-terraform-state` (versioned, CMEK)
- Artifact Registry `us-west1-docker.pkg.dev/TBD:aistudio-shared/aistudio`
- WIF pool `openclaw` with two providers: `github-actions`, `openclaw-local`
- Service accounts: `terraform-runner`, `openclaw-runtime`
- Org-wide audit log sink

Record outputs:
```bash
terraform output -json > bootstrap-outputs.json
```

### 3.3 Configure remote state

After bootstrap, add the GCS backend to each env's `backend.tf`:

```hcl
terraform {
  backend "gcs" {
    bucket = "aistudio-terraform-state"
    prefix = "env/dev"   # change per env
  }
}
```

### 3.4 Create env projects

Create `aistudio-dev`, `aistudio-staging`, `aistudio-prod` projects under the folder,
link billing, enable APIs (§1), then proceed to §4 per environment.

---

## 4. Per-Environment Deploy

Apply modules in dependency order. Terraform resolves most dependencies automatically via output references,
but the ordering below prevents bootstrap-time issues (especially VPC-SC).

See [terraform-arch.md §4](../../../.openclaw/workspace/specs/terraform-arch.md) for the full composition pattern.

### 4.1 Navigate to the env directory

```bash
cd aistudio/infra-gcp/env/dev   # or staging, prod
terraform init
```

### 4.2 Apply order and expected durations

| Step | Module(s) | Duration | Verify |
|------|-----------|----------|--------|
| 1 | `kms` | 2–3 min | KMS keyrings visible in console |
| 2 | `network` | 3–5 min | VPC + subnets + Cloud NAT visible |
| 3 | `iam` | 2–3 min | Service accounts created; bindings attached |
| 4 | `secrets`, `storage` | 2–4 min | Buckets exist (empty); Secret Manager entries exist (no version yet) |
| 5 | `alloydb`, `identity-platform` | 10–20 min | AlloyDB cluster state = READY; Identity Platform tenant visible |
| 6 | `vertex`, `dlp` | 3–5 min | Model Armor templates visible; DLP inspect templates created |
| 7 | `cloud-run-web`, `cloud-run-job` | 4–8 min | Cloud Run service deployed; health check returns 200 |
| 8 | `lb` | 5–10 min | Load balancer IP provisioned; cert pending or active |
| 9 | `scheduler`, `observability` | 2–5 min | Scheduler jobs listed; dashboards visible in Cloud Monitoring |
| 10 | `vpc-sc` | 3–5 min | Perimeter created in **dry-run mode** (enforce=false) |

```bash
terraform apply -target=module.kms
terraform apply -target=module.network
terraform apply -target=module.iam
terraform apply -target=module.secrets -target=module.storage
terraform apply -target=module.alloydb -target=module.identity_platform
terraform apply -target=module.vertex -target=module.dlp
terraform apply -target=module.cloud_run_web -target=module.cloud_run_job
terraform apply -target=module.lb
terraform apply -target=module.scheduler -target=module.observability
terraform apply -target=module.vpc_sc
```

Or apply everything at once (order is inferred from references) and Terraform handles sequencing:

```bash
terraform apply
```

The `vpc-sc` module always starts in dry-run (`enforce_mode=false`). Promote to enforce only after 7 clean dry-run days (plan §6.3).

### 4.3 Run database migrations

Migrations run via a Cloud Run Job (not at apply time):

```bash
gcloud run jobs execute aistudio-<env>-migrate \
  --region=us-west1 \
  --project=TBD:aistudio-<env>
```

Verify:

```bash
gcloud run jobs executions describe <execution-id> \
  --region=us-west1 --project=TBD:aistudio-<env>
```

### 4.4 Prod-specific checklist

Before applying prod:
- [ ] Staging has passed E2E suite for ≥72h (Gate G2 from plan §8.3)
- [ ] VPC-SC dry-run shows 0 violations in staging for ≥7 days
- [ ] `min_instances=1` and `cpu_always_allocated=true` are set in `prod/terraform.tfvars`
- [ ] AlloyDB read pool enabled (`enable_read_pool=true`)
- [ ] GitHub Actions manual approval gate reviewed and approved
- [ ] FERPA controls smoke test passed (§6 below)

---

## 5. Secrets & Config

### 5.1 Secret Manager entries required per environment

Terraform creates the Secret Manager resources; values must be populated by a human (or CI) after creation:

```bash
ENV=dev   # or staging, prod
PROJECT=TBD:aistudio-${ENV}

# NextAuth secret
echo -n "$(openssl rand -hex 32)" | \
  gcloud secrets versions add aistudio-${ENV}-nextauth-secret \
  --data-file=- --project=${PROJECT}

# AlloyDB initial password (set during alloydb module apply, rotate after)
# ... set by Terraform from a generated value; rotate here post-apply

# Identity Platform Web API key (from Identity Platform console)
echo -n "TBD:IDENTITY_PLATFORM_API_KEY" | \
  gcloud secrets versions add aistudio-${ENV}-identity-platform-api-key \
  --data-file=- --project=${PROJECT}

# OpenClaw MCP token (rotated separately; see runbook)
echo -n "TBD:OPENCLAW_MCP_TOKEN" | \
  gcloud secrets versions add aistudio-${ENV}-openclaw-mcp-token \
  --data-file=- --project=${PROJECT}

# Vertex AI endpoint (region-specific; usually auto-configured)
# Only needed if overriding the default us-west1 endpoint
```

### 5.2 Full secret list

| Secret name | Description | Env-specific? |
|-------------|-------------|---------------|
| `aistudio-<env>-nextauth-secret` | NextAuth JWT signing key | Yes |
| `aistudio-<env>-alloydb-password` | AlloyDB primary user password | Yes |
| `aistudio-<env>-identity-platform-api-key` | Identity Platform web client key | Yes |
| `aistudio-<env>-openclaw-mcp-token` | Bearer token for `aistudio-mcp` server | Yes |
| `aistudio-<env>-bookstack-sync-token` | Token for nightly BookStack sync job | Yes |
| `aistudio-shared-artifact-registry-sa` | Managed by WIF; no manual secret | Shared |

TBD: Confirm whether SendGrid API key or Gmail API OAuth client secret is needed (plan §12.4 open question).

### 5.3 Environment variables (non-secret)

Configured in `cloud-run-web` module tfvars. Key variables:

| Var | Dev | Staging | Prod |
|-----|-----|---------|------|
| `NEXT_PUBLIC_APP_URL` | `https://aistudio-dev.TBD:ssd.example` | `https://aistudio-staging.TBD:ssd.example` | `https://aistudio.TBD:ssd.example` |
| `VERTEX_REGION` | `us-west1` | `us-west1` | `us-west1` |
| `ALLOYDB_DATABASE` | `aistudio` | `aistudio` | `aistudio` |
| `NODE_ENV` | `development` | `production` | `production` |
| `LOG_LEVEL` | `debug` | `info` | `info` |

TBD: Final domain names post-DNS setup.

---

## 6. Post-Deploy Verification

### 6.1 Basic health checks

```bash
ENV=dev
SERVICE_URL=TBD:https://aistudio-dev.ssd.example

# Cloud Run service responding
curl -sf "${SERVICE_URL}/api/health" | jq .

# AlloyDB reachable from Cloud Run (check logs)
gcloud logging read \
  'resource.type="cloud_run_revision" AND textPayload:"warmed up successfully"' \
  --project=TBD:aistudio-${ENV} --limit=5

# Secret Manager access working
gcloud logging read \
  'resource.type="cloud_run_revision" AND severity=ERROR AND textPayload:"Secret"' \
  --project=TBD:aistudio-${ENV} --limit=10
```

### 6.2 Identity Platform smoke test

```bash
# Verify OIDC provider is configured
gcloud identity providers list --project=TBD:aistudio-${ENV}

# Manual: navigate to SERVICE_URL and attempt Workspace SSO login
```

### 6.3 Vertex AI Claude quota verification

```bash
# Check if Claude models are accessible
gcloud ai models list --region=us-west1 \
  --filter="name:claude" \
  --project=TBD:aistudio-prod

# Check quota
gcloud compute project-info describe --project=TBD:aistudio-prod \
  | grep -i vertex
```

If Claude models are not listed, the quota request (H2) has not yet been approved. Check:
`https://console.cloud.google.com/iam-admin/quotas?project=TBD:aistudio-prod`

### 6.4 FERPA tripwire smoke test

Run this **before** promoting staging to prod and before enabling enforce-mode VPC-SC.

```bash
# Send a synthetic SID payload to the API — should be BLOCKED with 422
curl -sf -X POST "${SERVICE_URL}/api/v1/executions" \
  -H "Authorization: Bearer TBD:TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"assistant_id":"smoke-test","input":{"text":"student_id 1234567 needs help"}}' \
  | jq .ferpa_redclass

# Expected: true (blocked)
# If this returns false or 200, STOP — FERPA middleware is misconfigured
```

Verify the alert fired in Pub/Sub:

```bash
gcloud pubsub subscriptions pull ferpa-tripwires-sub \
  --project=TBD:aistudio-${ENV} --limit=5 --auto-ack
```

Full FERPA test matrix: [ferpa-controls.md §5](../../../.openclaw/workspace/specs/ferpa-controls.md).

### 6.5 VPC-SC dry-run clean window

After applying `vpc-sc`, monitor dry-run violations for 7 days before promoting to enforce:

```bash
gcloud logging read \
  'resource.type="audited_resource" AND protoPayload.status.code=7 AND protoPayload.metadata.dryRun=true' \
  --project=TBD:aistudio-${ENV} --limit=20
```

Zero violations over 7 days = safe to flip `enforce_mode=true`.

---

## 7. Rollback

### 7.1 Cloud Run revision rollback

Traffic is instantly reroutable to any previous revision:

```bash
# List recent revisions
gcloud run revisions list --service=aistudio-web \
  --region=us-west1 --project=TBD:aistudio-prod

# Rollback to previous revision
gcloud run services update-traffic aistudio-web \
  --to-revisions=TBD:PREVIOUS_REVISION=100 \
  --region=us-west1 --project=TBD:aistudio-prod
```

### 7.2 AlloyDB point-in-time recovery (PITR)

AlloyDB provides continuous PITR within a 7-day window (dev) / 35-day window (prod).

```bash
# Restore to a specific time (replaces the cluster — do in dev/staging only; prod needs a new cluster)
gcloud alloydb clusters restore TBD:aistudio-prod-restored \
  --source-cluster=projects/TBD:aistudio-prod/locations/us-west1/clusters/aistudio-prod \
  --point-in-time="2026-04-19T03:00:00Z" \
  --region=us-west1 --project=TBD:aistudio-prod
```

For prod data incidents: restore to a new cluster name, verify data, then update the Cloud Run service's `DB_HOST` env var.

### 7.3 Terraform state recovery

State is stored in GCS with versioning enabled:

```bash
# List state versions
gsutil ls -la gs://aistudio-terraform-state/env/prod/

# Recover a specific version (replace VERSION_ID)
gsutil cp \
  gs://aistudio-terraform-state/env/prod/default.tfstate#TBD:VERSION_ID \
  gs://aistudio-terraform-state/env/prod/default.tfstate
```

### 7.4 OpenClaw MCP integration rollback

Remove the `aistudio` MCP entry from `openclaw.json` to disable the integration instantly (backup was created at registration time).

```bash
# Restore previous openclaw.json
cp ~/.openclaw/openclaw.json.bak.pre-aistudio-mcp-2026-04-19 ~/.openclaw/openclaw.json
```

### 7.5 Full environment teardown

If a phase needs to be completely unwound (see plan §8.7 rollback matrix):

```bash
cd aistudio/infra-gcp/env/dev
terraform destroy    # destroys all dev resources except AlloyDB (data safe)
```

AlloyDB data is not automatically destroyed by `terraform destroy` — it requires an explicit cluster deletion.

---

## 8. Known Quirks

### H2: Vertex Claude quota lead time

Quota approval for Claude models on Vertex AI `us-west1` can take days to weeks.
File the request on Day 0 before any other work. The Vertex module (`modules/vertex/`) will apply cleanly without it,
but Cloud Run will return 5xx on any Claude invocation until the quota is live.
Workaround: configure the provider factory to use Gemini (`gemini-2.0-flash`) as a temporary stand-in.

### WIF token refresh latency

The OpenClaw local runtime exchanges OIDC tokens for GCP STS tokens. STS tokens have a 1-hour TTL.
The `aistudio-mcp` server caches tokens with a 5-minute refresh lead (see [MCP protocol spec §5](../../../.openclaw/workspace/specs/aistudio-mcp-protocol.md)).
If the Mac Studio's system clock drifts >5 minutes, WIF token exchange will fail with `iam_credential_error`.
Fix: `sudo sntp -sS time.apple.com` to resync NTP.

### AlloyDB auto-pause (dev only)

In `aistudio-dev`, AlloyDB is configured to auto-pause after 1 hour of inactivity (saves ~$44/month).
The first Cloud Run request after a pause will be slow (30–60s connection establishment) and may time out.
This is expected in dev. Do not copy this setting to staging or prod.

### VPC-SC bootstrap ordering

The `vpc-sc` module must be applied **last**. Applying it before `alloydb` or `storage` are in the project
causes the perimeter to reject the Terraform runner's subsequent resource calls.
Always `terraform apply -target=module.vpc_sc` last.

### Cloud Run cold start + streaming

Dev and staging have `min_instances=0` (scale-to-zero). The first request after idle will have a 3–8s cold start.
NextAuth session validation happens before streaming begins, so users may see a blank page briefly.
This is expected in non-prod. Prod uses `min_instances=1` to avoid it.

### Identity Platform + NextAuth v5 OIDC adapter

NextAuth v5's `providers/google.ts` must be swapped for an Identity Platform OIDC provider config.
The client ID and authority URL come from the Identity Platform tenant, not from Google's standard OAuth2 endpoint.
See `lib/auth/` for the adapter implementation.

---

## 9. Troubleshooting Index

### `Error: googleapi: Error 403: Quota exceeded for quota metric 'alloydb.googleapis.com/AlloyDB_instances'`

AlloyDB instance quota is per-project. Request a quota increase in IAM & Admin → Quotas:
`alloydb.googleapis.com/AlloyDB_instances` — request at least 2 per region.

### `Error: generic::permission_denied: IAM permission 'aiplatform.endpoints.predict' denied`

The Cloud Run service account (`aistudio-web-sa@...`) is missing Vertex AI binding.
Check `modules/iam` bindings in the Terraform plan and re-apply `module.iam`.
Alternatively: `gcloud projects add-iam-policy-binding ... --role=roles/aiplatform.user`.

### `Error 401: Request had invalid authentication credentials` (WIF / MCP)

The WIF token has expired or the OIDC issuer URL doesn't match the configured WIF provider.
1. Verify `AISTUDIO_WIF_AUDIENCE` env var in `openclaw.json` matches the Terraform output `wif_provider_resource_name`.
2. Check NTP sync on Mac Studio (see §8 quirk above).
3. Fall back to bearer token auth (v0) by setting `AISTUDIO_API_TOKEN` directly.

### `VPC Service Controls violation` in Cloud Run logs

A Cloud Run service or job is trying to access a GCP service outside the VPC-SC perimeter.
Check `protoPayload.metadata.violationReason` in Cloud Logging.
Common cause: a new GCP SDK call to a service not in `restricted_services` list.
Fix: add the service to `vpc-sc` module's `restricted_services` variable + re-apply.
If urgent: temporarily set `enforce_mode=false` (back to dry-run) while you diagnose.

### Cloud Run 503 on startup — `connection refused` to AlloyDB

AlloyDB is either paused (dev) or the Cloud Run service account can't reach the private IP.
1. Check AlloyDB cluster state: `gcloud alloydb clusters describe aistudio-<env> --region=us-west1`.
2. Verify the Serverless VPC Connector is attached to the Cloud Run service (check `modules/cloud-run-web` Terraform).
3. Check AlloyDB IP is in the PSA range (`10.100.0.0/16`); Cloud Run VPC connector must be in the same VPC.

### `Module 'xxx' not found` during `terraform init`

Module source paths are relative. Run `terraform init` from `infra-gcp/env/<env>/`, not from `infra-gcp/`.
If Terraform is already initialized elsewhere, run `terraform init -reconfigure`.

### `ferpa_redclass: true` returned unexpectedly on a known-safe payload

A regex in the FERPA middleware is producing a false positive.
1. Check `ferpa-controls.md §3` regex patterns for the `SID` or `DOB` patterns — these require context to avoid false positives.
2. Review the request body for incidental 6–7 digit sequences (e.g., a zip code near a word like "student").
3. Log the `match_type` field in the blocked response and trace to the specific regex.
4. File a PR to tighten the regex with Vault sign-off before deploying the fix.

### `iam_credential_error: The service account ... does not exist`

Terraform applied `cloud-run-web` before `iam` finished propagating.
Service account creation has up to 60s eventual consistency.
Wait 60s and re-apply: `terraform apply -target=module.cloud_run_web`.

---

*Last updated: 2026-04-19. Plan version: v0.3.*
*See [migration plan](../../../.openclaw/workspace/aistudio-gcp-migration-plan.md) §11 for success criteria.*
