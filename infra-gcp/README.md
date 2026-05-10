# AI Studio on GCP — Terraform Infrastructure

This repository contains the Terraform infrastructure-as-code for deploying AI Studio to Google Cloud Platform.

## Quick reference

```bash
# Initialize environment (first time)
cd envs/dev
terraform init

# Plan changes
terraform plan -var-file=terraform.tfvars

# Apply changes (requires WIF credentials)
terraform apply -var-file=terraform.tfvars
```

## Structure

- **`modules/`** — Reusable Terraform modules (15 total)
  - `bootstrap/` — One-time setup (Terraform state, WIF, Artifact Registry)
  - `network/`, `vpc-sc/`, `iam/`, `kms/` — Foundation
  - `alloydb/`, `storage/`, `secrets/`, `identity-platform/` — Data plane
  - `cloud-run-web/`, `cloud-run-job/` — Compute
  - `vertex/`, `dlp/` — AI layer
  - `lb/`, `scheduler/`, `observability/` — Edge + ops

- **`envs/`** — Environment-specific configurations
  - `dev/` — Development environment (auto-pause, small instances)
  - `staging/` — Staging environment (medium capacity)
  - `prod/` — Production environment (HA, VPC-SC enforce, read pools)

## Guiding principles

1. **Environment parity by default** — Same modules across all envs; differences only in `tfvars`.
2. **CMEK everywhere** — Customer-managed encryption keys for all stateful resources.
3. **Tag-conditioned IAM** — Every role binding enforces environment tags (e.g., dev SAs cannot access prod secrets).
4. **WIF for CI/CD** — No long-lived service account keys. GitHub Actions and OpenClaw use short-lived WIF credentials.
5. **VPC Service Controls** — Perimeter enforced around AlloyDB, Vertex AI, GCS, and Secret Manager (prod only).

## Before you start

1. Read the **[Terraform Architecture Specification](../../../.openclaw/workspace/specs/terraform-arch.md)** (§2–7) for design details.
2. Ensure you have:
   - GCP organization access and billing account management rights
   - `gcloud` CLI configured with Application Default Credentials
   - Terraform 1.7+ installed locally
3. Create GCP projects (dev, staging, prod) and a shared project for state/WIF.

## Deployment workflow

### Phase 0: Bootstrap (run once per org)

```bash
# From the root of this repo
terraform -chdir=modules/bootstrap init
terraform -chdir=modules/bootstrap apply \
  -var="org_id=YOUR_ORG_ID" \
  -var="billing_account=YOUR_BILLING_ID" \
  -var="state_bucket_name=ssd201-aistudio-tfstate-shared" \
  -var="github_repo=nic-ssd201/aistudio-gcp" \
  -var="openclaw_local_issuer=http://localhost:18789"
```

(Project IDs and GCS bucket names are GLOBALLY unique — bare `aistudio-shared` / `aistudio-tfstate-shared` are taken. SSD201 deployments use the `ssd201-` prefix; substitute your own org-namespaced ID for other deployments.)

This creates:
- The shared (host) project (e.g. `ssd201-aistudio-shared`)
- GCS bucket for Terraform state
- Workload Identity Federation pool and providers
- Artifact Registry for Docker images

### Phase 1–3: Deploy dev → staging → prod

For each environment:

```bash
cd envs/dev  # (or staging/prod)
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
terraform init
terraform plan  # Review plan
terraform apply  # Requires manual approval for prod
```

## Module inventory

| Module | Inputs | Outputs | Purpose |
|--------|--------|---------|---------|
| `bootstrap` | org_id, billing_account | state_bucket_name, wif_pool_name, shared_project_id | One-time org setup |
| `network` | project_id, environment, region | vpc_self_link, subnet_ids, serverless_connector_name | VPC, subnets, NAT, PSA |
| `vpc-sc` | access_policy_name, perimeter_name, project_numbers | perimeter_name, violation_count | Service perimeter (FERPA boundary) |
| `iam` | project_id, environment, service_accounts, role_bindings | service_account_emails, custom_roles | Tag-conditioned IAM |
| `kms` | project_id, environment, keyring_name, keys | keyring_id, key_names | CMEK for all services |
| `alloydb` | project_id, vpc_self_link, psa_range, kms_key, cpu_count | cluster_uri, primary_instance_uri, primary_private_ip | Postgres + pgvector |
| `storage` | project_id, kms_key, buckets | bucket_names, bucket_urls | GCS buckets (attachments, repository, audit) |
| `secrets` | project_id, kms_key, secrets | secret_names, secret_version_refs | Secret Manager (values via CLI) |
| `cloud-run-web` | project_id, service_account_email, image, vpc_connector | service_url, latest_revision_name | Next.js app on Cloud Run |
| `cloud-run-job` | project_id, image, task_timeout_seconds | job_name, execution_name | Eventarc-triggered jobs (doc processing) |
| `identity-platform` | project_id, tenant_display_name, oidc_providers | tenant_id, oidc_issuer_url | Workspace IdP federation |
| `vertex` | project_id, enable_claude_models | model_armor_template_names | Vertex AI + Model Armor |
| `dlp` | project_id, inspect_templates, job_triggers | inspect_template_names | Cloud DLP (FERPA tripwires) |
| `observability` | project_id, slos, alert_channels | dashboard_ids, alert_policy_ids | Logging, Monitoring, Trace |
| `scheduler` | project_id, jobs | job_ids, job_names | Cloud Scheduler cron jobs |
| `lb` | project_id, backend_service_url, certificate_domain | load_balancer_ip, cloud_armor_policy_name | Global HTTPS LB + WAF |

## Environment variables

Each `envs/{env}/main.tf` expects:

- **dev**: `min_instances=0`, `max_instances=5`, `cpu_count=2`, VPC-SC dry-run
- **staging**: `min_instances=0`, `max_instances=20`, `cpu_count=2`, VPC-SC dry-run
- **prod**: `min_instances=1`, `max_instances=100`, `cpu_count=4`, VPC-SC enforced, read pools enabled

Customize in `terraform.tfvars`.

## CI/CD

- **Plan on PR** → `.github/workflows/terraform-plan.yml` runs in all envs, posts plan as comment
- **Apply on merge** → `.github/workflows/terraform-apply.yml` applies dev → staging, requires manual gate for prod
- **Identity** → WIF (Workload Identity Federation) for GitHub Actions, no long-lived keys

## Gotchas

1. **State bucket creation** — Bootstrap must run first and create the state bucket before any other env can initialize.
2. **VPC-SC dry-run → enforce** — Prod should run dry-run for 7 days minimum before enforcement to avoid service disruptions.
3. **Secret values** — Secrets are created *empty* by Terraform; populate them via `gcloud secrets versions add` or the GCP Console.
4. **DNS propagation** — After LB creation, update Cloud DNS records to point to the LB IP.

## Further reading

- [Terraform Architecture Specification](../../../.openclaw/workspace/specs/terraform-arch.md) — Full design details
- [GCP AI Studio Migration Plan](../../../.openclaw/workspace/aistudio-gcp-migration-plan.md) — Context, OpenClaw integration
- [FERPA Safety Specification](../../../.openclaw/workspace/specs/ferpa-controls.md) — Data classification, tripwires

---

**Status:** Boilerplate (scaffolding complete; modules awaiting implementation by Sonnet)

**Last updated:** 2026-04-19
