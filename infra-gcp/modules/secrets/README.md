# secrets module

**Purpose:** Secret Manager secrets with CMEK and access bindings (values populated via CLI, not Terraform).

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `kms_key` | string | yes | KMS key resource name for CMEK |
| `secrets` | map(object) | no | Secrets to create (name -> description, rotation_period, accessor_sa_emails) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `secret_ids` | Map of secret name -> secret ID |
| `secret_names` | Map of secret name -> resource name |
| `secret_version_refs` | Map of secret name -> version-pinned ref (sensitive) |

See spec §3.8.
