locals {
  # The SA account_id in GCP must be 6-30 chars. "sa-" prefix + name (<=24 chars)
  # keeps us within the limit.
  account_id = "sa-${var.name}"

  # Default project-level roles, composed from booleans.
  default_roles = toset(concat(
    var.cloud_logging_enabled ? ["roles/logging.logWriter"] : [],
    var.cloud_monitoring_enabled ? ["roles/monitoring.metricWriter"] : [],
    var.cloud_trace_enabled ? ["roles/cloudtrace.agent"] : [],
    var.vertex_ai_enabled ? ["roles/aiplatform.user"] : [],
  ))

  # Labels applied to the SA. Mandatory ones win over user-provided overrides.
  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      workload    = var.name
    },
  )
}

resource "google_service_account" "this" {
  project      = var.project_id
  account_id   = local.account_id
  display_name = "aistudio ${var.environment} ${var.name}"
  description  = var.description
  # labels is not a supported argument on google_service_account (provider ~> 6.0).
  # The var.labels input is intentionally kept for backward compat but is unused here.
  # Environment/workload info is encoded in account_id, display_name, and description.
}

# --- Default project-level roles -----------------------------------------

resource "google_project_iam_member" "default_roles" {
  for_each = local.default_roles

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.this.email}"
}

# --- GCS bucket bindings -------------------------------------------------

resource "google_storage_bucket_iam_member" "buckets" {
  for_each = {
    for b in var.storage_buckets :
    "${b.bucket}__${b.role}" => b
  }

  bucket = each.value.bucket
  role   = each.value.role
  member = "serviceAccount:${google_service_account.this.email}"
}

# --- Secret Manager bindings --------------------------------------------

resource "google_secret_manager_secret_iam_member" "secrets" {
  for_each = {
    for s in var.secrets :
    "${s.secret_id}__${s.role}" => s
  }

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = each.value.role
  member    = "serviceAccount:${google_service_account.this.email}"
}

# --- AlloyDB / Cloud SQL bindings (project role, scoped by IAM condition) ---
#
# google_project_iam_member.sql grants a project-level role but restricts it via
# a CEL condition so the SA can only operate on the named instance.
#
# Condition correctness (spec §3.16 review item):
#   - Cloud SQL resource name:  //sqladmin.googleapis.com/projects/P/instances/I
#   - AlloyDB cluster name:     //alloydb.googleapis.com/projects/P/locations/R/clusters/C
#   - AlloyDB instance name:    //alloydb.googleapis.com/projects/P/locations/R/clusters/C/instances/I
#
# `resource.name` in IAM conditions is the Cloud Resource Manager resource name,
# which for both services takes the form ".../instances/<id>". Using `endsWith`
# on the last path segment is the correct scoping pattern for both.
# The environment tag condition is stacked (AND) to prevent cross-env access.

resource "google_project_iam_member" "sql" {
  for_each = {
    for s in var.sql_instances :
    "${s.instance}__${s.role}" => s
  }

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.this.email}"

  condition {
    title       = "scope-to-${each.value.instance}-${var.environment}"
    description = "Restricts ${each.value.role} to instance '${each.value.instance}' in env '${var.environment}'."
    # Combine instance scoping with environment tag condition (AND semantics in a single expression).
    expression = "resource.name.endsWith('/instances/${each.value.instance}') && resource.matchTag('aistudio/environment', '${var.environment}')"
  }
}

# --- Pub/Sub topic bindings ---------------------------------------------

resource "google_pubsub_topic_iam_member" "topics" {
  for_each = {
    for t in var.pubsub_topics :
    "${t.topic}__${t.role}" => t
  }

  project = var.project_id
  topic   = each.value.topic
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.this.email}"
}

# --- Pub/Sub subscription bindings --------------------------------------

resource "google_pubsub_subscription_iam_member" "subscriptions" {
  for_each = {
    for s in var.pubsub_subscriptions :
    "${s.subscription}__${s.role}" => s
  }

  project      = var.project_id
  subscription = each.value.subscription
  role         = each.value.role
  member       = "serviceAccount:${google_service_account.this.email}"
}

# --- Escape hatch: additional project roles (optionally conditioned) ----

resource "google_project_iam_member" "additional" {
  for_each = {
    for idx, r in var.additional_project_roles :
    "${r.project}__${r.role}__${idx}" => r
  }

  project = each.value.project
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.this.email}"

  dynamic "condition" {
    for_each = each.value.condition != null ? [each.value.condition] : []

    content {
      title       = condition.value.title
      description = try(condition.value.description, null)
      expression  = condition.value.expression
    }
  }
}
