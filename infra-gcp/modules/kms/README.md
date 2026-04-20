# kms module

**Purpose:** KMS keyring and customer-managed encryption keys (CMEK) for AlloyDB, Cloud Storage, Secret Manager, Artifact Registry, and audit logs.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `keyring_name` | string | no | Keyring name (default: aistudio-{env}) |
| `keys` | map(object) | no | Keys to create (defaults: alloydb, storage, secrets, artifacts, audit-logs) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `keyring_id` | KMS keyring ID |
| `keyring_name` | KMS keyring resource name |
| `key_ids` | Map of key name -> key ID |
| `key_names` | Map of key name -> resource name |

See spec §3.5.
