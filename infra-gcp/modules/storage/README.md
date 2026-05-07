# storage module

**Purpose:** Bucket factory for attachments, repository documents, doc processing staging, and audit logs—all with CMEK, UBLA, and public access prevention.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `kms_key` | string | yes | KMS key resource name for CMEK |
| `buckets` | map(object) | no | Buckets to create (defaults: attachments, repository-documents, doc-processing-staging, audit-logs) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `bucket_names` | Map of logical bucket name -> actual bucket name |
| `bucket_urls` | Map of logical bucket name -> gs:// URL |

See spec §3.7.
