##############################################################################
# vertex/main.tf
# Creates: Vertex AI API enablement, Model Armor templates, IAM bindings.
# Spec ref: terraform-arch.md §3.12
#
# NOTE ON CLAUDE MODELS:
# If var.enable_claude_models = true, Claude access on Vertex AI requires:
#   1. Org-level model access approval via Anthropic partner agreement.
#   2. A quota increase request — see Nic's H2 quota request (Vertex AI Claude).
#   3. Manual deployment via Model Garden or google_vertex_ai_endpoint with
#      model references (NOT provisioned here — managed at env-level).
# This module only enables the API and signals intent via the output.
##############################################################################

locals {
  module_labels = merge(
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "vertex"
    },
    var.labels
  )

  # Normalize model_armor_templates into a consistent map.
  # Callers may pass: map(object) keyed by template name.
  armor_templates = var.model_armor_templates
}

###############################################################################
# 1. API enablement
###############################################################################
resource "google_project_service" "aiplatform" {
  project            = var.project_id
  service            = "aiplatform.googleapis.com"
  disable_on_destroy = false
}

# Model Armor is a google-beta resource (as of provider 6.x).
resource "google_project_service" "modelarmor" {
  project            = var.project_id
  service            = "modelarmor.googleapis.com"
  disable_on_destroy = false
}

###############################################################################
# 2. Model Armor templates
#    One per entry in var.model_armor_templates.
#    All filters set to SEVERITY_HIGH per spec §3.12.
#    Uses google-beta provider — Model Armor is beta-only.
###############################################################################
resource "google_model_armor_template" "this" {
  provider = google-beta
  for_each = local.armor_templates

  project     = var.project_id
  location    = var.region
  template_id = each.key

  labels = local.module_labels

  filter_config {
    # Malicious URI detection
    rai_settings {
      rai_filters {
        filter_type      = "MALICIOUS_URLS"
        confidence_level = "HIGH_AND_ABOVE"
      }
      # PII detection
      rai_filters {
        filter_type      = "SENSITIVE_DATA"
        confidence_level = "HIGH_AND_ABOVE"
      }
      # Jailbreak attempt detection
      rai_filters {
        filter_type      = "JAILBREAK"
        confidence_level = "HIGH_AND_ABOVE"
      }
      # Prompt injection detection
      rai_filters {
        filter_type      = "PROMPT_INJECTION"
        confidence_level = "HIGH_AND_ABOVE"
      }
    }
  }

  depends_on = [google_project_service.modelarmor]
}

###############################################################################
# 3. IAM — grant Vertex AI user role to the Cloud Run SA
#    Tag-conditioned: binding is scoped to resources tagged with this env.
###############################################################################
resource "google_project_iam_member" "cloud_run_vertex_user" {
  count   = var.cloud_run_sa_email != "" ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${var.cloud_run_sa_email}"

  condition {
    title       = "env-match-vertex-user"
    description = "Restrict Vertex AI user access to resources tagged with this environment"
    expression  = "resource.matchTag('aistudio/environment', '${var.environment}')"
  }

  depends_on = [google_project_service.aiplatform]
}
