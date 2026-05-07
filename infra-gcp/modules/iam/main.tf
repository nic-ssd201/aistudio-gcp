# iam/main.tf
#
# Project-level and cross-cutting IAM only. Per-workload SAs belong in sa-factory.
# Every binding carries a tag condition scoping it to the correct environment,
# mirroring the AWS CDK ServiceRoleFactory pattern from the spec §3.4.

locals {
  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "iam"
    },
  )
}

# ---------------------------------------------------------------------------
# Cross-cutting / platform service accounts
# ---------------------------------------------------------------------------
# These are the handful of SAs that span concerns (e.g., a shared log-sink
# writer, a cross-project Pub/Sub consumer). Workload-specific SAs live in
# sa-factory calls inside each compute module.

resource "google_service_account" "platform" {
  for_each = var.service_accounts

  project      = var.project_id
  account_id   = each.key
  display_name = each.value.display_name
  description  = each.value.description
}

# ---------------------------------------------------------------------------
# Role bindings for platform SAs
# ---------------------------------------------------------------------------

resource "google_project_iam_member" "platform_roles" {
  # Flatten the map(SA) → list(role) into a flat keyed map.
  for_each = {
    for pair in flatten([
      for sa_name, sa_spec in var.service_accounts : [
        for role in sa_spec.roles : {
          key     = "${sa_name}__${role}"
          sa_name = sa_name
          role    = role
        }
      ]
    ]) : pair.key => pair
  }

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.platform[each.value.sa_name].email}"

  # Tag condition: restricts the binding to resources tagged with the correct
  # environment, preventing a dev SA from touching prod resources at the IAM layer.
  condition {
    title       = "env-match-${var.environment}"
    description = "SA may only access resources tagged aistudio/environment=${var.environment}"
    expression  = "resource.matchTag('aistudio/environment', '${var.environment}')"
  }
}

# ---------------------------------------------------------------------------
# Arbitrary role_bindings (cross-cutting, caller-supplied)
# ---------------------------------------------------------------------------
# Each entry in var.role_bindings is an object:
#   { member, role, resource_type ("project"|"folder"|"org"), resource_id, condition_expression? }
# This handles cases like "grant terraform-runner roles/editor on project X" which
# don't fit the per-SA model above.

resource "google_project_iam_member" "bindings" {
  for_each = {
    for idx, b in var.role_bindings :
    "${b.member}__${b.role}__${idx}" => b
    if try(b.resource_type, "project") == "project"
  }

  project = try(each.value.resource_id, var.project_id)
  role    = each.value.role
  member  = each.value.member

  dynamic "condition" {
    # Apply a tag condition if the caller supplies one, otherwise fall back to
    # the standard environment tag condition for all custom bindings.
    for_each = try(each.value.condition_expression, null) != null ? [1] : [1]

    content {
      title = try(
        each.value.condition_title,
        "env-match-${var.environment}",
      )
      description = try(each.value.condition_description, null)
      expression = try(
        each.value.condition_expression,
        "resource.matchTag('aistudio/environment', '${var.environment}')",
      )
    }
  }
}

# ---------------------------------------------------------------------------
# Cross-cutting Cloud Run invoker bindings (run_invoker_bindings)
# ---------------------------------------------------------------------------
# These grant roles/run.invoker on a specific Cloud Run service or job to a
# caller-supplied SA member. Typical use: scheduler SA → doc-processing job.
# No tag condition applied: Run resource policies don't support matchTag() at
# the resource level; the binding is already scoped to a named resource.

resource "google_cloud_run_v2_service_iam_member" "run_invoker" {
  for_each = {
    for b in var.run_invoker_bindings :
    "service-${b.target_name}-${b.invoker_sa}" => b
    if b.target_kind == "service"
  }

  project  = each.value.project_id
  location = each.value.location
  name     = each.value.target_name
  role     = "roles/run.invoker"
  member   = each.value.invoker_sa
}

resource "google_cloud_run_v2_job_iam_member" "run_invoker" {
  for_each = {
    for b in var.run_invoker_bindings :
    "job-${b.target_name}-${b.invoker_sa}" => b
    if b.target_kind == "job"
  }

  project  = each.value.project_id
  location = each.value.location
  name     = each.value.target_name
  role     = "roles/run.invoker"
  member   = each.value.invoker_sa
}

# ---------------------------------------------------------------------------
# Cross-cutting Eventarc receiver bindings (eventarc_receiver_bindings)
# ---------------------------------------------------------------------------
# Grants roles/eventarc.eventReceiver at the project level for a given member.
# Typically the GCS service agent for a project needs this to route
# GCS-triggered Eventarc events. Service agents pre-date tag conditioning,
# so no tag condition is applied here.

resource "google_project_iam_member" "eventarc_receiver" {
  for_each = {
    for b in var.eventarc_receiver_bindings :
    "${b.project_id}-${b.member}" => b
  }

  project = each.value.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = each.value.member
}
