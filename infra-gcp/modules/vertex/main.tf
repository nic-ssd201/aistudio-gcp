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
    # RAI (Responsible AI) filters — the only valid filter_type enum values for
    # rai_settings.rai_filters[] are the 4 harm categories below. Confidence
    # levels: LOW_AND_ABOVE, MEDIUM_AND_ABOVE, HIGH (no HIGH_AND_ABOVE).
    #
    # Previously this block tried to set MALICIOUS_URLS / SENSITIVE_DATA /
    # JAILBREAK / PROMPT_INJECTION as rai_filters[] entries — those are NOT
    # RAI harm categories; the Model Armor API splits them into separate filter
    # blocks (malicious_uri_filter_settings, sdp_settings,
    # pi_and_jailbreak_filter_settings). Adding those is a separate follow-up
    # once we confirm the v1beta schema; for now we have RAI coverage only.
    rai_settings {
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "HIGH"
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
