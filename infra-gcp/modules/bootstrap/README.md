# bootstrap module

**Purpose:** One-time setup for Terraform state, Workload Identity Federation, and shared infrastructure (Artifact Registry, audit logging).

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `org_id` | string | yes | GCP organization ID |
| `billing_account` | string | yes | Billing account ID |
| `state_bucket_name` | string | yes | Globally unique GCS bucket name |
| `state_bucket_location` | string | no | GCS location (default: us-west1) |
| `github_repo` | string | yes | GitHub repo for WIF (e.g., psd401/aistudio) |
| `openclaw_local_issuer` | string | no | OIDC issuer URL (default: http://localhost:18789) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `state_bucket_name` | GCS bucket for Terraform state |
| `wif_pool_name` | Workload Identity Pool resource name |
| `github_provider_name` | GitHub Actions OIDC provider |
| `openclaw_provider_name` | OpenClaw OIDC provider |
| `terraform_runner_sa_email` | Service account for CI/CD |
| `openclaw_runtime_sa_email` | Service account for OpenClaw runtime |
| `artifact_registry_repository` | Docker registry URI |
| `shared_project_id` | Shared (host) project ID (e.g. `ssd201-aistudio-shared`) |

See spec §3.1.
