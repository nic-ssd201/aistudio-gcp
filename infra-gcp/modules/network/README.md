# network module

**Purpose:** Custom-mode VPC with subnets, Cloud Router, Cloud NAT, and Private Services Access for AlloyDB.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Primary region (default: us-west1) |
| `vpc_name` | string | no | VPC name (default: aistudio-vpc) |
| `subnet_cidrs` | map(string) | no | CIDR ranges for web/jobs/private-services |
| `enable_flow_logs` | bool | no | Enable VPC Flow Logs (default: true) |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `vpc_self_link` | VPC self-link for reference |
| `web_subnet_id` | Cloud Run VPC connector subnet |
| `jobs_subnet_id` | Cloud Run Jobs subnet |
| `private_services_subnet_id` | AlloyDB subnet |
| `serverless_connector_name` | Serverless VPC Connector resource name |
| `psa_range` | Private Services Access range |
| `cloud_router_id` | Cloud Router ID |
| `cloud_nat_id` | Cloud NAT ID |

See spec §3.2.
