# cloud-run-web module

**Purpose:** Next.js SSR application on Cloud Run with VPC connector, auto-scaling, and secret injection.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `service_account_email` | string | yes | Cloud Run SA email |
| `image` | string | yes | Container image URI |
| `vpc_connector` | string | yes | Serverless VPC Connector name |
| `min_instances` | number | no | Min instances (default: 0) |
| `max_instances` | number | no | Max instances (default: 5) |
| `concurrency` | number | no | Concurrency (default: 80) |
| `cpu_always_allocated` | bool | no | CPU always on (default: false) |
| `secret_refs` | map(string) | no | Secret Manager references |
| `env` | map(string) | no | Plain env vars |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `service_url` | Cloud Run service URL |
| `service_name` | Cloud Run service resource name |
| `latest_revision_name` | Latest revision resource name |

See spec §3.9.
