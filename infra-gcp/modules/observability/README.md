# observability module

**Purpose:** Alert policies, SLO resources, uptime checks, log sinks, notification channels, and a unified dashboard for AI Studio. Includes FERPA tripwire alerting (P1 fan-out to all 3 channels per ferpa-controls.md §6) and a dedicated 7-year-retention audit log bucket.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `region` | string | no | Region for FERPA audit bucket (default: us-west1) |
| `slos` | list(object) | no | SLO definitions |
| `alert_channels` | list(object) | yes (for FERPA) | Must include pagerduty + webhook_tokenauth (Telegram) + webhook_basicauth (Google Chat) |
| `uptime_urls` | list(object) | no | URLs to monitor |
| `audit_logs_bucket` | string | yes | GCS bucket for general audit logs (from storage module) |
| `ferpa_audit_bucket` | string | no | Existing FERPA audit bucket name. Empty = module creates one |
| `ferpa_audit_kms_key` | string | no | CMEK key for FERPA audit bucket (required if creating bucket) |
| `budget_alert_threshold` | number | no | Monthly budget USD: dev=5000, staging=10000, prod=20000 |
| `custom_dashboard_json` | string | no | Override the default unified dashboard JSON |
| `labels` | map(string) | no | Resource labels |

### `alert_channels` object shape

```hcl
{
  display_name = "Telegram qqbot"
  type         = "webhook_tokenauth"
  labels       = { url = "https://..." }
  sensitive_labels = { auth_token = data.google_secret_manager_secret_version.telegram.secret_data }
}
```

## Default alert policies

| Policy | Condition | Channels |
|---|---|---|
| Cloud Run error rate | > 5% for 5 min | All |
| AlloyDB CPU | > 80% for 10 min | Telegram |
| FERPA tripwire | Any occurrence | **PagerDuty + Telegram + Google Chat** |
| Vertex AI quota | > 80% for 5 min | Telegram |
| Budget warning | Log-based proxy (see gotchas) | Telegram |

## Outputs

| Name | Description |
|------|-------------|
| `dashboard_ids` | `{ unified = "<id>" }` |
| `alert_policy_ids` | Map of policy name → resource ID |
| `slo_ids` | Map of SLO display name → resource ID |
| `uptime_check_ids` | Map of check display name → check ID |
| `notification_channel_ids` | Map of channel display name → channel ID |
| `audit_log_sink_name` | General audit log sink resource name |
| `ferpa_audit_sink_name` | FERPA audit log sink resource name |
| `ferpa_audit_bucket_name` | FERPA audit bucket name (created or passed) |
| `ferpa_tripwire_metric_name` | Log-based metric name for FERPA tripwire events |
| `vpc_sc_violation_metric_name` | Log-based metric name for VPC-SC violations |

## Gotchas

- **Budget alerts**: `google_billing_budget` requires billing-account-level IAM. The budget_warning policy here is a log-based proxy. True budget alerts should be configured via a billing-scoped Terraform runner — confirm with Opus whether this belongs in bootstrap. See FERPA-REVIEW comment in main.tf.
- **FERPA retention lock**: The FERPA audit bucket `retention_policy.is_locked` is set to `false` by default. Set `true` only after confirming 7-year retention with the district records officer — locking is irreversible.
- **Channel completeness**: FERPA tripwire fan-out requires all 3 channel types. If `alert_channels` is missing any type at prod go-live, Vault must block promotion.
- **Budget alert threshold per env**: dev=$5k, staging=$10k, prod=$20k. Pass via `budget_alert_threshold` in tfvars.

See spec §3.14 and ferpa-controls.md §6, §7.
