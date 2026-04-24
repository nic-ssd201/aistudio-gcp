# lb module

**Purpose:** Global External HTTPS Load Balancer with Cloud Armor (OWASP + rate limit) and Cloud CDN.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `backend_service_url` | string | yes | Cloud Run service URL |
| `certificate_domain` | string | yes | Domain for SSL cert |
| `cloud_armor_policy` | any | no | Cloud Armor config (OWASP, rate limit) |
| `enable_cdn` | bool | no | Enable Cloud CDN (default: true) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `load_balancer_ip` | Global External IP |
| `load_balancer_url` | HTTPS URL |
| `health_check_id` | Health check ID |
| `cloud_armor_policy_name` | Cloud Armor policy resource name |

See spec §3.15.
