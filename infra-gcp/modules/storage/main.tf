# Storage module — bucket factory.
# Creates all GCS buckets from var.buckets map. Every bucket enforces UBLA, CMEK,
# public access prevention, and versioning. Lifecycle rules and retention policies
# are configured per-bucket from the map spec.
#
# Standard bucket set per env: attachments, repository-documents, doc-processing-staging, audit-logs.
#
# Wave D (dlp module) scans the "attachments" and "repository-documents" buckets via Eventarc
# triggers on GCS finalize events — those bucket names are exposed in outputs.bucket_names
# as an iterable map keyed by the logical bucket key (e.g. "attachments").
#
# FERPA note (ferpa-controls.md §7): The audit-logs bucket MUST use retention_days = 2555
# (7 years) per Washington state special-ed records requirement. This is not hardcoded here
# so the caller controls it — but the tfvars MUST pass 2555 for audit-logs.
# Vault review required before changing retention on audit-logs bucket.

locals {
  base_labels = {
    environment = var.environment
    managed-by  = "terraform"
    component   = "storage"
  }
  labels = merge(local.base_labels, var.labels)
}

resource "google_storage_bucket" "buckets" {
  for_each = var.buckets

  project = var.project_id
  # Naming: {name_prefix}-{env}-{name_suffix} — name_prefix MUST be org-namespaced
  # by the caller (e.g. "ssd201-aistudio"); GCS bucket names are globally unique
  # across all of GCS, so the bare "aistudio-" prefix would collide with other
  # deployments. See modules/storage/variables.tf "name_prefix" docstring.
  name     = "${var.name_prefix}-${var.environment}-${each.value.name_suffix}"
  location = each.value.location

  # UBLA: disables per-object ACLs — all access via IAM only.
  uniform_bucket_level_access = true

  # No object in this bucket should ever be public.
  public_access_prevention = "enforced"

  # Versioning protects against accidental overwrites — required by spec §1.
  versioning {
    enabled = true
  }

  # CMEK: all objects encrypted with the environment's storage key from the kms module.
  encryption {
    default_kms_key_name = var.kms_key
  }

  # Retention policy — only applied when retention_days > 0.
  # AUDIT-LOGS MUST have retention_days = 2555 (7 years, per ferpa-controls.md §7).
  # The retention policy is locked so no IAM principal can reduce it post-apply.
  dynamic "retention_policy" {
    for_each = each.value.retention_days > 0 ? [each.value.retention_days] : []
    content {
      retention_period = retention_policy.value * 86400 # convert days to seconds
      # is_locked=true prevents any future reduction of the retention period.
      # Only set on audit-logs (retention_days > 0); other buckets have no retention lock.
      is_locked = true
    }
  }

  # Lifecycle rules — iterates the per-bucket list from the map spec.
  # Supported action types: "SetStorageClass" (NEARLINE/COLDLINE/ARCHIVE) and "Delete".
  dynamic "lifecycle_rule" {
    for_each = each.value.lifecycle_rules
    content {
      action {
        type          = lifecycle_rule.value.action
        storage_class = lifecycle_rule.value.action == "SetStorageClass" ? lifecycle_rule.value.storage_class : null
      }
      condition {
        # age_days triggers on object age; num_newer_versions triggers on version count.
        # At least one condition field must be set in each rule.
        age                = lifecycle_rule.value.age_days
        num_newer_versions = lifecycle_rule.value.num_newer_versions
        with_state         = "ANY"
      }
    }
  }

  labels = local.labels

  lifecycle {
    # Prevent accidental bucket destruction — buckets are stateful and not trivially recreatable.
    prevent_destroy = true
  }
}
