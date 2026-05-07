# vpc-sc module

**Purpose:** VPC Service Controls perimeter around AI Studio project(s) to prevent data exfiltration via restricted APIs. Dry-run first — enforce only after 7 days of clean diffs.

## CRITICAL: Dry-Run Promotion Procedure

```
enforce_mode = false  →  dry-run (DEFAULT — violations logged, not blocked)
enforce_mode = true   →  enforced (violations become real access denials)
```

**DO NOT set `enforce_mode = true` until:**
1. Dry-run has run for at least 7 days with zero unexpected violations in the `aistudio_vpc_sc_violations` log-based metric.
2. All ingress rules (Console, GitHub Actions WIF, Workspace IdP) produce zero violations.
3. Nic has explicitly approved promotion in writing.

**Promoting too early will break all access to Vertex AI, AlloyDB, Secret Manager, Cloud Storage, and Artifact Registry.**

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `access_policy_name` | string | yes | Org-level access policy numeric name. Created out-of-band — do not manage here. |
| `perimeter_name` | string | yes | Perimeter name (underscores only, no hyphens) |
| `environment` | string | yes | dev/staging/prod |
| `project_numbers` | list(string) | yes | Project NUMBERS (not IDs). Use `data.google_project.*.number` at env level. |
| `restricted_services` | list(string) | no | Defaults: Vertex, AlloyDB, SecretManager, Storage, ArtifactRegistry |
| `ingress_rules` | list(object) | no | Extra ingress rules (appended to built-in Console/WIF/IdP rules) |
| `egress_rules` | list(object) | no | Extra egress rules (appended to built-in identitytoolkit egress) |
| `enforce_mode` | bool | no | Default: false (dry-run). See promotion procedure above. |
| `labels` | map(string) | no | Resource labels |

## Built-in ingress rules (always applied)

- Google Cloud Console / gcloud CLI (ANY_IDENTITY — tighten before enforce)
- Workspace IdP token flows
- GitHub Actions WIF calls (via var.ingress_rules — caller must supply WIF SA principal)

## Outputs

| Name | Description |
|------|-------------|
| `perimeter_name` | Full resource name of the service perimeter |
| `perimeter_status` | `"dry-run"` or `"enforced"` |
| `violation_count_metric` | Log-based metric name for VPC-SC violations |
| `enforce_mode` | Current enforce mode bool |

## Gotchas

- `project_numbers` requires numbers, not IDs. At env level: `data "google_project" "this" { project_id = var.project_id }` then `module.vpc_sc.project_numbers = [data.google_project.this.number]`.
- `access_policy_name` is the numeric policy ID (e.g., `"1234567890"`), NOT the display name.
- Perimeter name must use underscores only — the resource path is `accessPolicies/<id>/servicePerimeters/<name>`.
- The built-in ingress rules use `identity_type = ANY_IDENTITY` during dry-run to avoid lockouts. Before promoting to enforce, replace with explicit principal lists.
- VPC-SC violation count is tracked via the log-based metric created in the `observability` module. Apply `observability` before reading violation metrics.

See spec §3.3.
