# cloud-run-job module

**Purpose:** Reusable Cloud Run Job template for document processing, nightly syncs, and Eventarc-triggered cron tasks.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `job_name` | string | yes | Cloud Run Job name |
| `service_account_email` | string | yes | Cloud Run Job SA email |
| `image` | string | yes | Container image URI |
| `vpc_connector` | string | no | Serverless VPC Connector name |
| `task_timeout_seconds` | number | no | Task timeout (default: 3600) |
| `retries` | number | no | Retries on failure (default: 1) |
| `secret_refs` | map(string) | no | Secret Manager references |
| `env` | map(string) | no | Plain env vars |
| `eventarc_triggers` | any | no | Eventarc trigger configs |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `job_name` | Cloud Run Job resource name |
| `execution_name` | Latest execution resource name |

See spec §3.10.
