# Secrets module — Secret Manager secret shells.
# Creates secret resources with CMEK and IAM bindings; no initial versions.
# Nic / CI populates values post-apply via `gcloud secrets versions add`.
#
# CMEK requires user_managed replication with explicit replica locations — automatic
# replication does not support customer-managed encryption keys. We replicate to a
# single region (var.region) which is sufficient for a single-region GCP deployment.
#
# Standard secrets expected in var.secrets (document in tfvars, not hardcoded here):
#   alloydb-initial-password    — postgres superuser password for AlloyDB cluster
#   aistudio-nextauth-secret    — NextAuth v5 NEXTAUTH_SECRET
#   aistudio-mcp-token          — Bearer token for aistudio-mcp server auth
#   vertex-api-key              — Vertex AI API key (if not using WIF ADC)
#   pagerduty-routing-key       — ferpa-controls.md §6 P1 alert fan-out
#   telegram-qqbot-token        — ferpa-controls.md §6 P1 alert fan-out
#
# outputs.version_refs is shaped for direct paste into Cloud Run secret_key_ref:
#   value_source.secret_key_ref.secret  = secrets["key"].name
#   value_source.secret_key_ref.version = "latest"

locals {
  base_labels = {
    environment = var.environment
    managed-by  = "terraform"
    component   = "secrets"
  }
  labels = merge(local.base_labels, var.labels)

  # Flatten secret × accessor_sa_email pairs for IAM binding resources.
  # We use google_secret_manager_secret_iam_member (additive) rather than
  # _iam_policy (authoritative) to avoid accidentally removing bindings managed
  # outside Terraform (e.g., manual break-glass grants during incidents).
  iam_bindings = flatten([
    for secret_key, spec in var.secrets : [
      for email in spec.accessor_sa_emails : {
        secret_key = secret_key
        email      = email
      }
    ]
  ])
}

resource "google_secret_manager_secret" "secrets" {
  for_each = var.secrets

  project   = var.project_id
  secret_id = "aistudio-${var.environment}-${each.key}"

  # User-managed replication is required for CMEK — automatic replication does not
  # support customer-managed encryption keys per GCP documentation.
  replication {
    user_managed {
      replicas {
        location = var.region
        customer_managed_encryption {
          kms_key_name = var.kms_key
        }
      }
    }
  }

  # Rotation: google_secret_manager_secret requires both `rotation` and `topics`
  # blocks together (provider ~> 6.0 enforces the pair). This module does not
  # manage the Pub/Sub notification topic, so rotation is intentionally omitted
  # here. If secret rotation is needed, wire a separate google_secret_manager_secret
  # resource with both blocks, or use the Secret Manager console.
  # The rotation_period variable is retained in variables.tf for forward compat.

  labels = local.labels
}

# IAM bindings — additive, one resource per secret × accessor SA pair.
# Condition scopes each binding to resources tagged with the matching environment,
# following the tag-conditioned IAM pattern from spec §3.4.
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = {
    for binding in local.iam_bindings :
    "${binding.secret_key}--${binding.email}" => binding
  }

  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.value.secret_key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.email}"

  # Tag-conditioned binding: SA can only access secrets tagged aistudio/environment={env}.
  # This blocks a dev SA from accidentally accessing a prod secret even if it somehow
  # obtained the resource name.
  condition {
    title       = "env-match-${var.environment}"
    description = "Restrict access to secrets tagged with environment=${var.environment}"
    expression  = "resource.matchTag('aistudio/environment', '${var.environment}')"
  }
}
