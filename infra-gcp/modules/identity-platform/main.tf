##############################################################################
# identity-platform/main.tf
# Creates: Identity Platform tenant + Google Workspace OIDC provider wiring.
# Spec ref: terraform-arch.md §3.11
##############################################################################

locals {
  module_labels = merge(
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "identity-platform"
    },
    var.labels
  )
}

###############################################################################
# 1. API enablement
###############################################################################
resource "google_project_service" "identitytoolkit" {
  project            = var.project_id
  service            = "identitytoolkit.googleapis.com"
  disable_on_destroy = false
}

###############################################################################
# 2. Identity Platform tenant
#    SSO-only: password signup disabled, anonymous sign-in blocked.
###############################################################################
resource "google_identity_platform_tenant" "this" {
  project               = var.project_id
  display_name          = var.tenant_display_name
  allow_password_signup = false

  # Block anonymous sign-in entirely (defense-in-depth for FERPA).
  # enable_anonymous_user is not a valid argument on google_identity_platform_tenant
  # (provider ~> 6.0). Anonymous auth is disabled by default; explicit blocking is
  # handled via google_identity_platform_config.this sign_in.anonymous below.
  disable_auth = false

  depends_on = [google_project_service.identitytoolkit]
}

###############################################################################
# 3. Authorized domains
#    Applied at project level (Identity Platform config resource).
###############################################################################
resource "google_identity_platform_config" "this" {
  project = var.project_id

  authorized_domains = var.authorized_domains

  # Block anonymous sign-in at the project config level too.
  sign_in {
    anonymous {
      enabled = false
    }
    email {
      enabled           = false
      password_required = false
    }
  }

  depends_on = [google_project_service.identitytoolkit]
}

###############################################################################
# 4. OIDC providers (one per entry in var.oidc_providers)
#    Workspace OIDC issuer: https://accounts.google.com
#    client_secret is passed as a Secret Manager resource name — the caller
#    must supply the version ref from secrets.outputs.version_refs.
###############################################################################
resource "google_identity_platform_tenant_oauth_idp_config" "oidc" {
  # nonsensitive() because var.oidc_providers is marked sensitive (holds
  # client_secret_value), but the display_name keys we iterate over are not
  # secret. Terraform's static analysis can't determine that the keys come from
  # a non-sensitive subset of the value, so we assert it explicitly here. The
  # sensitive attributes (client_secret) still flow through each.value.* and
  # remain redacted in plan/state via the provider's own sensitive markers.
  for_each = nonsensitive({ for p in var.oidc_providers : p.display_name => p })

  project = var.project_id
  tenant  = google_identity_platform_tenant.this.name

  # provider ID must be prefixed with "oidc."
  name         = "oidc.${replace(lower(each.key), " ", "-")}"
  display_name = each.value.display_name
  client_id    = each.value.client_id
  issuer       = each.value.issuer
  enabled      = true

  # client_secret is supplied from Secret Manager at apply time.
  # The caller passes the *plaintext* secret value via var.oidc_providers[].client_secret_value,
  # which they should source from `data "google_secret_manager_secret_version"` in the env
  # composition layer — never hardcoded. See variables.tf note.
  client_secret = each.value.client_secret_value

  depends_on = [google_identity_platform_tenant.this]
}
