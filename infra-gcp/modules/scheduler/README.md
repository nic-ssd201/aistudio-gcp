# scheduler module

**Purpose:** Cloud Scheduler cron jobs for nightly syncs, BookStack pipeline, and maintenance tasks.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `jobs` | any | no | Scheduler job definitions (name -> cron, target, etc.) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `job_ids` | Map of job name -> resource ID |
| `job_names` | Map of job name -> resource name |

See spec §3.15.
