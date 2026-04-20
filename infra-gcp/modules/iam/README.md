# iam module

**Purpose:** Service account creation and tag-conditioned IAM bindings (every binding enforces environment-match conditions).

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `service_accounts` | map(object) | no | SAs to create (name -> display_name, description, roles) |
| `role_bindings` | any | no | Tag-conditioned role bindings |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `service_account_emails` | Map of SA name -> email |
| `service_account_names` | Map of SA name -> resource name |
| `custom_roles` | Map of custom role name -> resource name |

See spec §3.4.
