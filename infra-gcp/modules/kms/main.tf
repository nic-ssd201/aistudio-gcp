# kms/main.tf
#
# Creates one KMS KeyRing per environment plus the standard set of keys
# (alloydb, storage, secrets, artifacts, audit-logs). Every downstream module
# that stores persistent data pulls the relevant key ID from kms outputs —
# never a data source.

locals {
  # Use caller-supplied name or derive the standard convention.
  keyring_name = var.keyring_name != "" ? var.keyring_name : "aistudio-${var.environment}"

  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "kms"
    },
  )
}

# ---------------------------------------------------------------------------
# KeyRing
# ---------------------------------------------------------------------------

resource "google_kms_key_ring" "main" {
  project  = var.project_id
  name     = local.keyring_name
  location = var.region

  # KeyRings cannot be deleted in GCP; prevent_destroy avoids confusing plan diffs.
  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------

resource "google_kms_crypto_key" "keys" {
  for_each = var.keys

  name     = each.key
  key_ring = google_kms_key_ring.main.id

  # Default: 90 days (7776000s). Individual keys may override via var.keys[*].rotation_period.
  rotation_period = each.value.rotation_period

  # ENCRYPT_DECRYPT covers all CMEK use-cases; ASYMMETRIC_* is a separate workflow.
  purpose = "ENCRYPT_DECRYPT"

  labels = merge(local.labels, { key-purpose = replace(each.value.purpose, " ", "-") })

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Grant the relevant GCP service agents encrypter/decrypter on each key.
# These bindings allow GCS, AlloyDB, Secret Manager etc. to use CMEK without
# the calling module needing to know the service agent email pattern.
# ---------------------------------------------------------------------------

# GCS service agent (needed by the storage module and the bootstrap state bucket).
resource "google_kms_crypto_key_iam_member" "gcs" {
  for_each = { for k, v in var.keys : k => v if contains(["storage", "audit-logs"], k) }

  crypto_key_id = google_kms_crypto_key.keys[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gs-project-accounts.iam.gserviceaccount.com"
}

# Secret Manager service agent.
resource "google_kms_crypto_key_iam_member" "secretmanager" {
  for_each = { for k, v in var.keys : k => v if k == "secrets" }

  crypto_key_id = google_kms_crypto_key.keys[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-secretmanager.iam.gserviceaccount.com"
}

# Artifact Registry service agent.
resource "google_kms_crypto_key_iam_member" "artifactregistry" {
  for_each = { for k, v in var.keys : k => v if k == "artifacts" }

  crypto_key_id = google_kms_crypto_key.keys[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-artifactregistry.iam.gserviceaccount.com"
}

# AlloyDB service agent.
resource "google_kms_crypto_key_iam_member" "alloydb" {
  for_each = { for k, v in var.keys : k => v if k == "alloydb" }

  crypto_key_id = google_kms_crypto_key.keys[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-alloydb.iam.gserviceaccount.com"
}

# ---------------------------------------------------------------------------
# Project data source (internal — the spec allows data sources scoped to the
# current environment, which this is: it only reads the project we're operating in).
# ---------------------------------------------------------------------------

data "google_project" "current" {
  project_id = var.project_id
}
