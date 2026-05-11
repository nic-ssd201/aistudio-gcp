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

  # GCP label values must be lowercase (regex: [\p{Ll}\p{Lo}\p{N}_-]{0,63}). The
  # asymmetric_keys block at line ~133 already does lower() — keep this in sync.
  labels = merge(local.labels, { key-purpose = replace(lower(each.value.purpose), " ", "-") })

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
# ASYMMETRIC_SIGN keys (separate resource — different purpose + algorithm).
#
# Used for application-level signing operations (e.g. JWT signing for the
# OAuth2/OIDC provider). The private key never leaves KMS; sign operations
# go via cloudkms.signer, public-key fetch goes via cloudkms.viewer (both
# bundled in roles/cloudkms.signerVerifier).
# ---------------------------------------------------------------------------

resource "google_kms_crypto_key" "signing_keys" {
  for_each = var.signing_keys

  name     = each.key
  key_ring = google_kms_key_ring.main.id

  # No rotation_period: Cloud KMS doesn't support automatic rotation for
  # ASYMMETRIC_SIGN keys (the API rejects rotation_period on this purpose).
  # New versions are created manually via `gcloud kms keys versions create`
  # when rotation is needed; the application's KMS_SIGNING_KEY_NAME env var
  # must then be bumped to point at the new cryptoKeyVersions/N path.
  purpose = "ASYMMETRIC_SIGN"

  version_template {
    algorithm        = each.value.algorithm
    protection_level = "SOFTWARE"
  }

  # GCP label values must match [a-z0-9_-]{0,63} — lowercase + dash/underscore only.
  # The purpose string is human-readable ("OAuth2/OIDC RS256 JWT signing"), so
  # downcase and squash slashes/spaces before using it as a label value.
  labels = merge(local.labels, {
    key-purpose = replace(replace(lower(each.value.purpose), " ", "-"), "/", "-")
    key-type    = "asymmetric-sign"
  })

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Project data source (internal — the spec allows data sources scoped to the
# current environment, which this is: it only reads the project we're operating in).
# ---------------------------------------------------------------------------

data "google_project" "current" {
  project_id = var.project_id
}
