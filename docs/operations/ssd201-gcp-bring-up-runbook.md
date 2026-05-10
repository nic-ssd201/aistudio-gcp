# SSD201 GCP Bring-Up Runbook

**Audience:** Nic (or whoever runs the first `terraform apply` against fresh GCP projects).
**Goal:** Take the SSD201 fork from "code merged, no infra" to "live dev environment serving traffic at `dev-aistudio.sunnysideschools.org`."
**Time:** ~2–3 hours of active work, plus 30–60 min of `terraform apply` wait time.

This is a runbook, not a tutorial. It assumes you've read `infra-gcp/README.md` and `infra-gcp/envs/bootstrap/README.md` once. Every command is copy-paste-runnable. Where a command requires you to fill in a value, the value is in `<ANGLE_BRACKETS>`.

---

## Phase 0 — Decide + provision prereqs (your hands; not Terraform)

These are decisions or actions that Terraform cannot make for you because they involve billing, org-level IAM, or domain ownership.

### 0.1 — Decisions to lock before starting

| Decision | Default / suggestion | Notes |
|---|---|---|
| GCP organization | The SSD201 / sunnysideschools.org org | Needed for `org_id`. If "no org," skip the org-level audit log sink. |
| Billing account | Existing Sunnyside billing account | Needs Billing Admin to attach. ~$50–$200/mo for dev at idle. |
| Region | `us-west1` | Matches existing Terraform examples. Don't change without auditing every module. |
| Shared project ID | `ssd201-aistudio-shared` | Holds Artifact Registry + state bucket + WIF. Used by all envs. **`ssd201-` prefix is mandatory** — bare `aistudio-shared` is globally taken by another GCP user. |
| Dev project ID | `ssd201-aistudio-dev` | Holds dev's AlloyDB, Cloud Run, secrets, etc. **`ssd201-` prefix is mandatory** — bare `aistudio-dev` is globally taken. Same global-namespace constraint applies to all GCS bucket names this stack creates (storage module passes `name_prefix = "ssd201-aistudio"` for the same reason). |
| Domain (dev) | `dev-aistudio.sunnysideschools.org` | You need DNS write access. Cloud LB managed cert needs the A-record set before SSL provisioning starts. |
| Breakglass email | A monitored shared inbox (`it-breakglass@sunnysideschools.org`) | Receives budget alerts on day 1. Not a personal address. |
| GitHub WIF claim | `nic-ssd201/aistudio-gcp` | Tells WIF which repo can assume the Terraform-runner SA. The `dev.tfvars.example` default has been updated to match this fork; verify in 1.1 if you've forked further. |

### 0.2 — Look up org_id and billing_account

```bash
gcloud auth login                       # interactive browser, account with org admin
gcloud auth application-default login   # for Terraform/SDK use

# Find org ID (numeric, looks like 123456789012)
gcloud organizations list

# Find billing account ID (format XXXXXX-XXXXXX-XXXXXX)
gcloud billing accounts list
```

Write these down. They go into `dev.tfvars`.

### 0.3 — Create the two GCP projects

Terraform **adopts** these projects via data source — it does NOT create them. They must exist before `terraform apply`.

```bash
# Replace <ORG_ID> and <BILLING_ACCOUNT> with the values from 0.2
gcloud projects create ssd201-aistudio-shared --organization=<ORG_ID>
gcloud projects create ssd201-aistudio-dev    --organization=<ORG_ID>

# Link billing — required before creating any billable resource
gcloud beta billing projects link ssd201-aistudio-shared --billing-account=<BILLING_ACCOUNT>
gcloud beta billing projects link ssd201-aistudio-dev    --billing-account=<BILLING_ACCOUNT>

# Verify
gcloud projects list --filter='project_id:aistudio-*'
gcloud beta billing projects describe ssd201-aistudio-shared
gcloud beta billing projects describe ssd201-aistudio-dev
```

If `projects create` fails with `Permission 'resourcemanager.projects.create' denied`, you need `roles/resourcemanager.projectCreator` at the org level. Have an org admin grant it or run the command for you.

### 0.4 — Enable required APIs in both projects

The bootstrap module enables most APIs, but it needs a few enabled BEFORE its first apply (otherwise the state bucket creation fails). Belt-and-suspenders: enable the foundational APIs in both projects up front:

```bash
for project in ssd201-aistudio-shared ssd201-aistudio-dev; do
  gcloud services enable \
    cloudresourcemanager.googleapis.com \
    cloudbilling.googleapis.com \
    iam.googleapis.com \
    serviceusage.googleapis.com \
    storage.googleapis.com \
    cloudkms.googleapis.com \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    --project=$project
done
```

(The Terraform modules will enable additional APIs as needed — alloydb, vpcaccess, certificatemanager, identitytoolkit, etc. — but the four added here are pre-reqs for Phase 3 / 4 commands and for Phase 5 secret writes that happen outside Terraform.)

---

## Phase 1 — Bootstrap apply (chicken-and-egg state bucket)

**Output of this phase:** state bucket exists, Artifact Registry exists, WIF pool exists, dev billing budget exists, breakglass email channel exists.

### 1.1 — Set up `dev.tfvars`

```bash
# Anchor the repo root once so the rest of the runbook is portable
export REPO_ROOT="$(git rev-parse --show-toplevel)"   # or hardcode if not in the repo

cd "$REPO_ROOT/infra-gcp/envs/bootstrap"
cp dev.tfvars.example dev.tfvars
```

Edit `dev.tfvars` and fill in:
- `org_id` (from 0.2)
- `billing_account` (from 0.2)
- `breakglass_email` (from 0.1)
- **`github_repo`** — `dev.tfvars.example` now defaults to `nic-ssd201/aistudio-gcp`. Verify it matches the repo you'll deploy from (the WIF principalSet binding hardcodes this; getting it wrong means CI can't deploy until you re-apply bootstrap with the right value).

Other defaults (`env`, `host_project_id`, `env_project_id`, `budget_amount_usd`) are sensible — only change if you've deviated from the suggested project IDs in 0.1.

### 1.2 — First apply (LOCAL backend, then migrate to GCS)

The bootstrap module **creates** the state bucket. `backend.tf` declares the backend as `"gcs"` but with no config — at first init we'll override to a local backend, apply, then re-init to migrate state to the freshly-created bucket.

```bash
# Step 1: temp local backend
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF

terraform init -reconfigure
terraform apply -var-file=dev.tfvars
# Approve when plan looks right. Takes ~3-5 min.
```

Verify the state bucket exists:
```bash
gcloud storage buckets describe gs://ssd201-aistudio-tfstate-shared --project=ssd201-aistudio-shared
```

### 1.3 — Migrate state to GCS

```bash
# Remove the local backend override
rm backend_override.tf

# Re-init with the GCS backend; Terraform will offer to copy local state up
terraform init \
  -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
  -backend-config="prefix=bootstrap/dev" \
  -migrate-state
# Type 'yes' when it asks if you want to copy existing state.

# Sanity-check: should report "No changes."
terraform plan -var-file=dev.tfvars

# CRITICAL CLEANUP — these files must go before the next apply, or a future
# `terraform init` (without -reconfigure) will pick them up and get confused
# about which backend is authoritative:
rm -f terraform.tfstate terraform.tfstate.backup    # local state copies are now stale
# Only if a prior local apply was interrupted/killed (a lock file in the tree
# usually signals a half-finished operation, not stale residue):
rm -f .terraform.tfstate.lock.info
# (backend_override.tf was already removed at the top of this step)
```

### 1.4 — Capture bootstrap outputs

```bash
terraform output
# Note these values for Phase 2 / 4:
#   - artifact_registry_repository → for Phase 4 image push
#   - shared_project_id            → confirms ssd201-aistudio-shared
#   - terraform_runner_sa_email    → for CI/WIF wiring later
```

---

## Phase 2 — Dev env apply

**Output:** VPC, AlloyDB cluster, KMS keys, Cloud Run web (placeholder image), Cloud Run doc-processor (placeholder image), GCS buckets, Secret Manager secrets (empty + AlloyDB password seeded), Identity Platform tenant, LB (no SSL cert yet), scheduler jobs, observability dashboards, VPC-SC perimeter (dry-run).

> **⚠️ Why this phase splits in two (2.2a → 2.2b → 2.2c):** the AlloyDB module (`infra-gcp/modules/alloydb/main.tf:30-34`) reads `alloydb-initial-password` via `data "google_secret_manager_secret_version" "initial_password"` with `version = "latest"`. If no version exists when the cluster is planned, the apply **fails outright** before any cluster is created. So the order has to be: create the secret resource → seed its value → then create AlloyDB. Don't try to populate the password in Phase 5 — by then the apply has already failed.

### 2.1 — Set up `terraform.tfvars`

```bash
cd "$REPO_ROOT/infra-gcp/envs/dev"
cp terraform.tfvars.example terraform.tfvars
```

Edit — fill in: `domain_name`, `vpc_sc_access_policy_name`, `workspace_oidc_client_id`, `workspace_oidc_client_secret`. (See `infra-gcp/envs/dev/terraform.tfvars.example` for guidance on each.)

For `vpc_sc_access_policy_name`:
```bash
gcloud access-context-manager policies list --organization=<ORG_ID>
# Returns the numeric policy ID
```

For `workspace_oidc_client_id` / `_secret`:
- GCP Console → APIs & Services → Credentials → OAuth 2.0 Client IDs
- Create one if it doesn't exist; type "Web application," authorized redirect URI = `https://<domain_name>/api/auth/callback/google`

### 2.2a — Init + targeted apply for the secrets module ONLY

> **Backend pattern:** `infra-gcp/envs/dev/backend.tf` no longer hardcodes a bucket name (matches the `envs/bootstrap/backend.tf` pattern as of this PR). The `-backend-config` flags below supply the bucket + prefix at init time. If you ran `terraform init` against an older revision and have a `.terraform/` cached backend config, add `-reconfigure` to the init below.

```bash
terraform init \
  -reconfigure \
  -backend-config="bucket=ssd201-aistudio-tfstate-shared" \
  -backend-config="prefix=envs/dev"

# Targeted apply — creates the Secret Manager secrets (4 of them) plus their
# upstream dependencies (KMS keyring + secret-encryption key, web/doc-processor
# service accounts, project-services API enablement, IAM accessor bindings).
# Expect ~25-40 resources and ~3-5 minutes, NOT just the secrets themselves.
# Goal of this targeted step: get the alloydb-initial-password resource created
# so we can seed it in 2.2b before AlloyDB tries to read it in 2.2c.
terraform apply -var-file=terraform.tfvars -target=module.secrets
```

### 2.2b — Seed the AlloyDB initial password (mandatory before full apply)

```bash
openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add \
  alloydb-initial-password --data-file=- --project ssd201-aistudio-dev

# Verify
gcloud secrets versions list alloydb-initial-password --project ssd201-aistudio-dev
# Should show one ENABLED version.
```

The other three secrets (`aistudio-mcp-token-encryption-key`, `aistudio-nextauth-secret`, `aistudio-mcp-token`) can be populated in Phase 5 — only AlloyDB has a Terraform-time data-source dependency.

### 2.2c — Full apply

```bash
terraform plan -var-file=terraform.tfvars
# Expect ~80–120 additional resources to be created. Skim for surprises.

terraform apply -var-file=terraform.tfvars
# 15–25 minutes. AlloyDB cluster creation is the slow path (~10 min).
```

### 2.3 — Capture dev outputs

```bash
terraform output
# Note especially:
#   - load_balancer_ip      → for Phase 6 DNS A record
#   - web_service_url       → direct Cloud Run URL (curl /api/health here pre-DNS)
#   - alloydb_cluster_name  → for monitoring filters / connection troubleshooting
#   - artifact_registry_repo → for Phase 3/4 image push (cross-check matches us-west1)
```

(Note: there's no AlloyDB IP output today. If you need it, query directly:
`gcloud alloydb instances describe primary --cluster=ssd201-aistudio-dev --region=us-west1 --project=ssd201-aistudio-dev --format='value(ipAddress)'`)

---

## Phase 3 — Build + push web image

The Cloud Run web service is currently pointed at a placeholder. Build the real Next.js image and deploy it.

```bash
cd "$REPO_ROOT"

# Submit Cloud Build (uploads context, builds in GCP, pushes to Artifact Registry)
gcloud builds submit \
  --tag us-west1-docker.pkg.dev/ssd201-aistudio-shared/aistudio/aistudio-web:dev-latest \
  --file Dockerfile \
  --project ssd201-aistudio-shared \
  .

# Deploy the new image to the dev web service.
# IMPORTANT — service naming asymmetry:
#   - cloud-run-web sets service_name = "aistudio-${var.environment}-web", so the
#     dev web service is `aistudio-dev-web` (and `aistudio-staging-web`, `aistudio-prod-web`)
#   - cloud-run-worker / envs/dev/main.tf hardcode the doc-processor as `aistudio-doc-processor`
#     (no env prefix). Don't pattern-match the wrong way between these two.
gcloud run deploy aistudio-dev-web \
  --image us-west1-docker.pkg.dev/ssd201-aistudio-shared/aistudio/aistudio-web:dev-latest \
  --region us-west1 \
  --project ssd201-aistudio-dev
```

Verify:
```bash
WEB_URL=$(gcloud run services describe aistudio-dev-web \
  --region us-west1 --project ssd201-aistudio-dev --format='value(status.url)')
curl -sS "$WEB_URL/api/health"
# → some 200 response
```

---

## Phase 4 — Build + push document-processor image

Same pattern as Phase 3 but for the worker, and using a service-specific Dockerfile.

```bash
cd "$REPO_ROOT"

gcloud builds submit \
  --tag us-west1-docker.pkg.dev/ssd201-aistudio-shared/aistudio/aistudio-doc-processor:dev-latest \
  --file infra/cloud-run-services/document-processor/Dockerfile \
  --project ssd201-aistudio-shared \
  .

gcloud run deploy aistudio-doc-processor \
  --image us-west1-docker.pkg.dev/ssd201-aistudio-shared/aistudio/aistudio-doc-processor:dev-latest \
  --region us-west1 \
  --project ssd201-aistudio-dev
```

Verify (the only unauth'd route):
```bash
PROC_URL=$(gcloud run services describe aistudio-doc-processor \
  --region us-west1 --project ssd201-aistudio-dev --format='value(status.url)')
curl -sS "$PROC_URL/healthz"
# → 200
```

`/process-job` and `/admin/cleanup-jobs` require OIDC tokens from the Cloud Tasks / Scheduler invoker SAs — don't try them by hand.

---

## Phase 5 — Populate secret values (4 secrets)

Terraform creates the secret resources but not their values (so values aren't in tfstate). Set them out-of-band with `gcloud secrets versions add`.

### 5.1 — `aistudio-mcp-token-encryption-key`

DEK seed for MCP per-user OAuth field-level encryption. HKDF-SHA-256 derives the actual 32-byte key, so the input just needs to be high-entropy random.

```bash
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add \
  aistudio-mcp-token-encryption-key --data-file=- --project ssd201-aistudio-dev
```

### 5.2 — `aistudio-nextauth-secret`

NextAuth session signing secret. 32+ random bytes.

```bash
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add \
  aistudio-nextauth-secret --data-file=- --project ssd201-aistudio-dev
```

(All `openssl rand -base64` outputs include a trailing newline by default; piping through `tr -d '\n'` keeps the secret value clean across all four secrets in this section. NextAuth + HKDF tolerate the newline, but consistency avoids a future copy-paste footgun.)

### 5.3 — `aistudio-mcp-token`

MCP API bearer token. Whatever value you've issued for MCP server auth.

```bash
# Silent prompt — keeps the token out of ~/.bash_history and process listings
read -rs MCP_BEARER_TOKEN
echo  # newline after the silent input
printf %s "$MCP_BEARER_TOKEN" | gcloud secrets versions add \
  aistudio-mcp-token --data-file=- --project ssd201-aistudio-dev
unset MCP_BEARER_TOKEN
```

### 5.4 — `alloydb-initial-password` (already seeded in Phase 2.2b)

This secret was set in Phase 2.2b — nothing to do here on first deploy. **If you skipped 2.2b and the Phase 2.2c apply failed at AlloyDB creation, go back and seed 2.2b before re-running apply.**

**Rotation (post-creation):** if you later need to rotate the postgres password (e.g. credential exposure), the workflow is:

```bash
# 1. Add a new secret version
openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add \
  alloydb-initial-password --data-file=- --project ssd201-aistudio-dev

# 2. Apply the new password to the AlloyDB cluster
NEW_PASSWORD=$(gcloud secrets versions access latest \
  --secret alloydb-initial-password --project ssd201-aistudio-dev)

gcloud alloydb users update postgres \
  --cluster ssd201-aistudio-dev \
  --region us-west1 \
  --project ssd201-aistudio-dev \
  --password="$NEW_PASSWORD"

# 3. Bounce Cloud Run so the new connection string takes effect (see 5.6)
```

Note: the data source in `modules/alloydb/main.tf` only reads the secret at plan time, so changing the secret value after creation does NOT trigger a Terraform diff. The `gcloud alloydb users update` step in 2 above is what actually rotates the cluster's password.

### 5.5 — Verify all four

```bash
for s in aistudio-mcp-token-encryption-key aistudio-nextauth-secret aistudio-mcp-token alloydb-initial-password; do
  echo "$s:"
  gcloud secrets versions list "$s" --project ssd201-aistudio-dev --limit=1
done
```

Each should show one ENABLED version.

### 5.6 — Bounce Cloud Run to pick up new secret values

Secrets resolve at instance start, not per-request. Force a new revision by **redeploying the same image** — gcloud auto-suffixes a new revision name on every deploy, and image is in Terraform's `lifecycle.ignore_changes` so this doesn't drift:

```bash
# Look up the image each service is currently running
WEB_IMAGE=$(gcloud run services describe aistudio-dev-web \
  --region us-west1 --project ssd201-aistudio-dev --format='value(spec.template.spec.containers[0].image)')
PROC_IMAGE=$(gcloud run services describe aistudio-doc-processor \
  --region us-west1 --project ssd201-aistudio-dev --format='value(spec.template.spec.containers[0].image)')

# Re-deploy each at its current image — forces a new revision, no spec changes
gcloud run deploy aistudio-dev-web \
  --image "$WEB_IMAGE" --region us-west1 --project ssd201-aistudio-dev
gcloud run deploy aistudio-doc-processor \
  --image "$PROC_IMAGE" --region us-west1 --project ssd201-aistudio-dev
```

> **Why not `--update-env-vars FORCE_REVISION=...`:** that approach works but causes Terraform drift — `cloud-run-web/main.tf` only has `image` in `ignore_changes`, not `env`, so the next `terraform plan` will want to remove the FORCE_REVISION var (and any future apply will roll yet another revision dropping it). Re-deploying at the same image is drift-free.

---

## Phase 6 — DNS + SSL

```bash
# Get the LB IP from Phase 2 outputs
cd "$REPO_ROOT/infra-gcp/envs/dev"
LB_IP=$(terraform output -raw load_balancer_ip)
echo "Point dev-aistudio.sunnysideschools.org A → $LB_IP"
```

Create an A record at your DNS provider for `dev-aistudio.sunnysideschools.org` → `<LB_IP>`. Wait for propagation (`dig +short dev-aistudio.sunnysideschools.org` returns the LB IP).

Cloud LB's managed cert provisioning starts automatically once the A record resolves. The LB module uses the **Certificate Manager API** (not legacy compute SSL certs), so:

```bash
gcloud certificate-manager certificates describe ssd201-aistudio-dev-cert \
  --location=global \
  --project=ssd201-aistudio-dev
# Look for state: ACTIVE — can take 15-60 minutes after DNS propagates
```

---

## Phase 7 — Smoke tests

### 7.1 — App reachable

```bash
curl -sS https://dev-aistudio.sunnysideschools.org/api/health
# → 200
```

### 7.2 — OIDC login works

In a browser: visit `https://dev-aistudio.sunnysideschools.org`, click sign in with Google, complete the flow. Should land on the home page authed.

### 7.3 — Doc upload + process end-to-end

In the dev app: upload a small PDF (5-10 pages). Watch logs in two terminals:

```bash
# Terminal 1: web app upload handler
gcloud run services logs tail aistudio-dev-web \
  --region us-west1 --project ssd201-aistudio-dev

# Terminal 2: document processor
gcloud run services logs tail aistudio-doc-processor \
  --region us-west1 --project ssd201-aistudio-dev
```

Expected sequence:
1. Web logs `Server-side upload request` → `Job created` → `File uploaded to storage` → `Processing queued`
2. Within ~5–60 seconds, processor logs `Processing job <jobId>` → `Job completed`
3. UI shows extracted text

If the UI hangs at "Processing...":
```bash
# Connect to AlloyDB via the gcloud client (uses an auth proxy under the hood)
gcloud alloydb instances connect primary \
  --cluster=ssd201-aistudio-dev \
  --region=us-west1 \
  --project=ssd201-aistudio-dev \
  --user=postgres
# (Authenticates via your gcloud session; you'll be dropped into psql against the aistudio db.)

# Then in psql:
SELECT id, status, error_message, created_at FROM document_jobs ORDER BY created_at DESC LIMIT 5;
```

---

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `terraform init` fails: `Permission denied on bucket ssd201-aistudio-tfstate-shared` | Phase 1 wasn't completed (state bucket doesn't exist) | Run Phase 1 first. |
| `terraform apply` fails: `Permission 'resourcemanager.projects.get' denied` | Active gcloud account lacks IAM on the project | `gcloud auth login` with an account that has owner/editor on the project. |
| `gcloud builds submit` fails: `Cloud Build API has not been used` | Cloud Build API not enabled in `ssd201-aistudio-shared` | `gcloud services enable cloudbuild.googleapis.com --project=ssd201-aistudio-shared` |
| `gcloud run deploy` reports success but `/process-job` 404s | Service is still on cloudrun-hello placeholder | Re-run Phase 4 — `--image` flag must point at the real image. |
| Doc upload hangs at "Processing...", processor logs are silent | Cloud Tasks queue not granted invoker on the worker, OR worker SA can't reach AlloyDB | Check `gcloud iam policies analyze ...` and `gcloud run services logs tail` for OIDC verification errors. |
| App shows "Token encryption DEK is unavailable" | Phase 5.1 was skipped | Set the secret value, bounce web revision (Phase 5.6). |
| LB cert stuck in `PROVISIONING` after >1 hour | DNS A record not resolving to the LB IP yet | `dig +short <domain>` should match LB IP. Check propagation. |
| AlloyDB connection refused | Postgres password mismatch between secret + cluster | Phase 5.4 fix path (gcloud alloydb users update). |

---

## Rollback / teardown

If a `terraform apply` lands you somewhere broken and you want to start over:

```bash
cd "$REPO_ROOT/infra-gcp/envs/dev"
terraform destroy -var-file=terraform.tfvars
# Approve. Takes ~10 min.

cd ../bootstrap
terraform destroy -var-file=dev.tfvars
# Approve. Note: KMS keys are not actually deleted (Google holds them in scheduled deletion for 30 days);
# the next apply will need to import them or wait out the soft-delete window.
```

Then delete the projects (frees the project IDs after 30 days):
```bash
gcloud projects delete ssd201-aistudio-dev
gcloud projects delete ssd201-aistudio-shared
```

---

## What this runbook does NOT cover

- Staging or prod bring-up (`envs/staging`, `envs/prod`) — same shape but separate billing budgets, separate VPC-SC perimeter, manual `terraform apply` approval gates. Do dev first, capture lessons, then staging, then prod.
- WIF wiring for GitHub Actions — Phase 1 creates the WIF pool, but the GitHub Actions workflow needs a separate PR to use it. Lower priority; manual deploys via `gcloud run deploy` are fine for dev iteration.
- Lambda retirement (`infra/lambdas/{file-processor,document-processor-v2,url-processor,agent-router}/`) — these still exist in the AWS-targeted CDK stack. Deletion is gated on the Cloud Run document-processor (Phase 4 + 7) being verified end-to-end. Do that, then delete the Lambda directories in a follow-up PR.
- Image generation pipeline — separate slice (Vertex Imagen vs. Bedrock; not yet ported).
- Safety layer (Model Armor / DLP wiring) — separate slice.

---

## Sequence summary (TL;DR)

```
Phase 0:   gcloud login + create projects + link billing      ~30 min
Phase 1:   bootstrap apply (local→GCS state migration)        ~10 min
Phase 2:   dev env apply                                      ~25 min  (AlloyDB is slow)
Phase 3:   web image build + deploy                           ~10 min
Phase 4:   doc-processor image build + deploy                 ~5 min
Phase 5:   set 4 secret values + bounce revisions             ~5 min
Phase 6:   DNS A record + wait for SSL cert                   ~30-60 min wait
Phase 7:   smoke tests (login, upload, process)               ~10 min
```

If you hit any step where the runbook is wrong, fix it in this file as part of the same PR — future-you will thank present-you.
