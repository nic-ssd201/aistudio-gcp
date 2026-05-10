# bootstrap/main.tf
#
# Run-once org bootstrap. Reads the pre-created shared project, then manages the
# GCS state bucket, Artifact Registry, WIF pool + two providers, two SAs, and an
# org-level audit log sink. Apply manually with elevated credentials once per org;
# subsequent runs are no-ops because every critical resource has `prevent_destroy = true`.
#
# PRE-CREATION REQUIREMENT
# ------------------------
# The shared project MUST be created manually before the first `terraform apply`.
# Bootstrap does NOT create or destroy the project — it only adopts it via a data source.
# This keeps `terraform destroy` from ever deleting the shared project or orphaning state.
#
# Project IDs are GLOBALLY unique across all of GCP — bare `aistudio-shared` is taken,
# so SSD201 deployments use `ssd201-aistudio-shared`. Substitute your own org-namespaced
# ID in the commands below.
#
# One-time setup (run once by an org admin):
#
#   gcloud projects create ssd201-aistudio-shared \
#     --organization=<ORG_ID> \
#     --name="AI Studio Shared"
#
#   gcloud billing projects link ssd201-aistudio-shared \
#     --billing-account=<BILLING_ACCOUNT_ID>
#
# After that, set host_project_id = "ssd201-aistudio-shared" in the env root and apply.

locals {
  labels = merge(
    var.labels,
    {
      environment = "shared"
      managed-by  = "terraform"
      component   = "bootstrap"
    },
  )
}

# ---------------------------------------------------------------------------
# Shared project (pre-created manually — Terraform adopts, never creates/destroys)
# ---------------------------------------------------------------------------

data "google_project" "shared" {
  project_id = var.host_project_id
}

# APIs needed in the shared project.
resource "google_project_service" "shared_apis" {
  for_each = toset([
    "cloudkms.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "billingbudgets.googleapis.com",
  ])

  project            = data.google_project.shared.project_id
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# KMS key for state bucket CMEK
# ---------------------------------------------------------------------------

resource "google_kms_key_ring" "bootstrap" {
  project  = data.google_project.shared.project_id
  name     = "aistudio-bootstrap"
  location = var.state_bucket_location

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "state_bucket" {
  name            = "state-bucket"
  key_ring        = google_kms_key_ring.bootstrap.id
  rotation_period = "7776000s" # 90 days

  labels = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

# Grant the GCS service agent permission to use the key.
resource "google_kms_crypto_key_iam_member" "gcs_sa_state" {
  crypto_key_id = google_kms_crypto_key.state_bucket.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  # The GCS service agent follows this deterministic format per project number.
  member = "serviceAccount:service-${data.google_project.shared.number}@gs-project-accounts.iam.gserviceaccount.com"
}

# ---------------------------------------------------------------------------
# GCS state bucket
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "state" {
  project  = data.google_project.shared.project_id
  name     = var.state_bucket_name
  location = var.state_bucket_location

  # Versioning ensures we can recover from accidental state corruption.
  versioning {
    enabled = true
  }

  # CMEK: every object encrypted with our managed key.
  encryption {
    default_kms_key_name = google_kms_crypto_key.state_bucket.id
  }

  # Uniform bucket-level access prevents per-object ACLs from leaking state.
  uniform_bucket_level_access = true

  # Block all public access — state files must never be world-readable.
  public_access_prevention = "enforced"

  labels = local.labels

  # Losing the state bucket is catastrophic; prevent accidental `terraform destroy`.
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_kms_crypto_key_iam_member.gcs_sa_state]
}

# ---------------------------------------------------------------------------
# Artifact Registry (Docker)
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "docker" {
  project       = data.google_project.shared.project_id
  location      = var.state_bucket_location # co-locate with state for latency
  repository_id = "aistudio"
  description   = "AI Studio container images"
  format        = "DOCKER"

  labels = local.labels

  depends_on = [google_project_service.shared_apis]

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Workload Identity Federation pool + providers
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "main" {
  project                   = data.google_project.shared.project_id
  workload_identity_pool_id = "aistudio-wif-pool"
  display_name              = "AI Studio WIF Pool"
  description               = "Shared WIF pool for GitHub Actions and OpenClaw local runtime"

  depends_on = [google_project_service.shared_apis]
}

# Provider: GitHub Actions OIDC
resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = data.google_project.shared.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.main.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions"
  description                        = "OIDC provider for GitHub Actions CI/CD"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # Map GitHub claims to GCP attributes for principalSet binding.
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
  }

  # Only tokens from the configured repo may authenticate.
  attribute_condition = "assertion.repository == '${var.github_repo}'"
}

# Provider: OpenClaw local runtime OIDC
resource "google_iam_workload_identity_pool_provider" "openclaw" {
  project                            = data.google_project.shared.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.main.workload_identity_pool_id
  workload_identity_pool_provider_id = "openclaw-local"
  display_name                       = "OpenClaw Local Runtime"
  description                        = "OIDC provider for OpenClaw agent automation on Nic's Mac"

  oidc {
    issuer_uri = var.openclaw_local_issuer
  }

  attribute_mapping = {
    "google.subject"  = "assertion.sub"
    "attribute.agent" = "assertion.agent"
  }
}

# ---------------------------------------------------------------------------
# Service accounts
# ---------------------------------------------------------------------------

resource "google_service_account" "terraform_runner" {
  project      = data.google_project.shared.project_id
  account_id   = "terraform-runner"
  display_name = "Terraform Runner"
  description  = "Assumed by GitHub Actions WIF to plan/apply Terraform"
}

resource "google_service_account" "openclaw_runtime" {
  project      = data.google_project.shared.project_id
  account_id   = "openclaw-runtime"
  display_name = "OpenClaw Runtime"
  description  = "Assumed by OpenClaw local agent via WIF for GCP operations"
}

# ---------------------------------------------------------------------------
# WIF → SA impersonation bindings (no SA keys — WIF only, per spec §1 & §3)
# ---------------------------------------------------------------------------

# GitHub Actions can impersonate terraform-runner for any branch/PR in the repo.
resource "google_service_account_iam_member" "github_terraform_runner" {
  service_account_id = google_service_account.terraform_runner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.main.name}/attribute.repository/${var.github_repo}"
}

# OpenClaw local can impersonate openclaw-runtime for automation tasks.
resource "google_service_account_iam_member" "openclaw_runtime_wif" {
  service_account_id = google_service_account.openclaw_runtime.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.main.name}/attribute.agent/openclaw"
}

# terraform-runner needs elevated rights in the shared project to manage
# state bucket objects and Artifact Registry.
resource "google_project_iam_member" "terraform_runner_storage" {
  project = data.google_project.shared.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.terraform_runner.email}"
}

resource "google_project_iam_member" "terraform_runner_ar_writer" {
  project = data.google_project.shared.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.terraform_runner.email}"
}

# ---------------------------------------------------------------------------
# Org-level audit log sink
# ---------------------------------------------------------------------------

# Destination bucket for org audit logs in the shared project.
resource "google_storage_bucket" "audit_logs" {
  project  = data.google_project.shared.project_id
  name     = "${var.state_bucket_name}-audit-logs"
  location = var.state_bucket_location

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # 7-year retention satisfies typical K-12 records-retention requirements.
  retention_policy {
    is_locked        = false     # lock after initial compliance review
    retention_period = 220752000 # 7 years in seconds
  }

  labels = merge(local.labels, { purpose = "audit-logs" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_logging_organization_sink" "audit" {
  name             = "aistudio-org-audit-sink"
  org_id           = var.org_id
  destination      = "storage.googleapis.com/${google_storage_bucket.audit_logs.name}"
  include_children = true

  # Capture all admin activity and data access logs.
  filter = "logName:(\"activity\" OR \"data_access\")"
}

# Grant the log sink's writer SA access to write into the audit log bucket.
resource "google_storage_bucket_iam_member" "audit_sink_writer" {
  bucket = google_storage_bucket.audit_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_organization_sink.audit.writer_identity
}

# ---------------------------------------------------------------------------
# Breakglass email notification channel
# ---------------------------------------------------------------------------
#
# This channel is created in bootstrap so budget alerts can fire from day 1,
# without depending on the observability module (which is applied later and
# owns the operational PagerDuty/Telegram channels). Any budget whose
# notification_channels list is empty will automatically fall back to this
# address via coalescelist() in budgets.tf.

resource "google_monitoring_notification_channel" "breakglass" {
  project      = data.google_project.shared.project_id
  display_name = "Breakglass Email (${var.breakglass_email})"
  type         = "email"

  labels = {
    email_address = var.breakglass_email
  }

  description = "Fallback notification channel for billing budget alerts. Owned by bootstrap so budgets can fire on day 1 before observability channels exist."

  depends_on = [google_project_service.shared_apis]
}
