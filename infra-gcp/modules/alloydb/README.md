# alloydb module

**Purpose:** AlloyDB cluster and primary instance with pgvector support and optional read pool.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `vpc_self_link` | string | yes | VPC self-link from network module |
| `psa_range` | string | yes | Private Services Access range |
| `kms_key` | string | yes | KMS key resource name for CMEK |
| `cluster_name` | string | no | Cluster name (default: aistudio-{env}) |
| `cpu_count` | number | no | CPU count (default: 2, must be 2/4/8/16) |
| `initial_user_password_secret` | string | yes | Secret Manager password reference |
| `enable_read_pool` | bool | no | Enable read pool (default: false) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `cluster_uri` | AlloyDB cluster URI |
| `primary_instance_uri` | Primary instance URI |
| `read_pool_instance_uri` | Read pool instance URI (if enabled) |
| `primary_private_ip` | Primary instance IP |
| `connection_string` | Sample connection string (sensitive) |

See spec §3.6.
