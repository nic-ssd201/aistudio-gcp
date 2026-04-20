# identity-platform module

**Purpose:** Identity Platform tenant federated to Google Workspace SSO (OIDC). SSO-only — password signup and anonymous sign-in are disabled. Provides the auth layer for AI Studio staff access.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `tenant_display_name` | string | yes | Tenant display name, e.g. `SSD Staff` |
| `authorized_domains` | list(string) | no | Domains allowed to sign in |
| `oidc_providers` | list(object) | no | OIDC provider configs — see shape below |
| `labels` | map(string) | no | Resource labels |

### `oidc_providers` object shape

```hcl
{
  display_name        = "Google Workspace"
  client_id           = "123456789.apps.googleusercontent.com"
  issuer              = "https://accounts.google.com"   # Workspace OIDC issuer
  client_secret_value = data.google_secret_manager_secret_version.oidc_secret.secret_data
}
```

`client_secret_value` must be sourced from Secret Manager at env composition level. NEVER hardcode it. The variable is marked `sensitive = true`.

## Outputs

| Name | Description |
|------|-------------|
| `tenant_id` | Identity Platform tenant resource name |
| `tenant_name` | Identity Platform tenant resource name (same as tenant_id) |
| `oidc_provider_names` | Map of display_name → full OIDC provider resource name |
| `oidc_issuer_url` | `https://accounts.google.com` |
| `oidc_audience` | Tenant-scoped audience for token validation |

## Gotchas

- `google_identity_platform_config` is a singleton per project — if another resource manages it, import before applying.
- OIDC provider IDs are auto-prefixed `oidc.` and normalized to lowercase-with-hyphens from `display_name`.
- `google_identity_platform_tenant` does not support a `labels` field; labels are applied at the project config level where supported.

See spec §3.11.
