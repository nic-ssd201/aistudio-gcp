# vertex module

**Purpose:** Vertex AI API enablement, Model Armor templates for content filtering (malicious URI, PII, jailbreak, prompt injection — all at SEVERITY_HIGH), and IAM bindings for the Cloud Run SA.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `region` | string | no | Primary region (default: us-west1) |
| `environment` | string | yes | dev/staging/prod |
| `model_armor_templates` | map(any) | no | Template IDs to create. Map keys become template IDs. Default: `{ "aistudio-default" = {} }` |
| `enable_claude_models` | bool | no | Signal Claude model intent. Does NOT provision endpoints — see note below |
| `cloud_run_sa_email` | string | no | Cloud Run SA email from sa-factory output. Granted roles/aiplatform.user with tag-conditioned binding |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `model_armor_template_names` | Map of template ID → full resource name |
| `vertex_api_enabled` | Whether Vertex AI API is enabled |
| `enable_claude_models` | Whether Claude model access was requested |

## Claude Models on Vertex

Setting `enable_claude_models = true` does NOT provision Claude model endpoints. It signals intent and outputs a flag. Actual enablement requires:

1. Org-level model access approval via the Anthropic partner agreement.
2. A quota increase request filed by Nic (target: H2 2026).
3. Manual Model Garden deployment or a `google_vertex_ai_endpoint` resource managed at env level.

This module only enables the `aiplatform.googleapis.com` API and `modelarmor.googleapis.com` API.

## Gotchas

- `google_model_armor_template` uses the `google-beta` provider (Model Armor is beta-only as of 2026-04).
- All 4 filter types are hardcoded at `HIGH_AND_ABOVE`. The `model_armor_templates` map values are currently unused (marker only); future versions can extend to per-template filter overrides.
- Tag-conditioned IAM binding requires the `aistudio/environment` tag key to exist at org level (created by bootstrap module).

See spec §3.12.
