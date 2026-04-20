##############################################################################
# scheduler/main.tf
# Cloud Scheduler jobs for cron-driven and on-demand task execution.
#
# Design notes
# ------------
# * OIDC auth: Scheduler authenticates to Cloud Run Jobs / arbitrary URLs
#   using an OIDC token minted for var.scheduler_sa_email. The SA must have
#   roles/run.invoker on each target Cloud Run Job. That binding is NOT
#   created here — it belongs in sa-factory or the job module to avoid
#   circular dependencies.
# * Cloud Run Job invoke URL format:
#     https://<region>-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/<project_id>/jobs/<job_name>:run
#   This is the v1 API endpoint — it works for both gen1 and gen2 jobs.
# * time_zone: default "America/Los_Angeles" because Nic and the district are
#   in Washington state. All cron times in the OpenClaw CLAUDE.md are PST/PDT.
# * target_type="cloud_run_job" is the primary use case. "url" is an escape
#   hatch for webhooks, legacy HTTP endpoints, or OpenClaw gateway callbacks.
# * The body field is optional; Cloud Run Jobs don't need a request body but
#   arbitrary URL targets may (e.g. OpenClaw webhook with a JSON payload).
##############################################################################

locals {
  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "scheduler"
    }
  )
}

resource "google_cloud_scheduler_job" "jobs" {
  for_each = var.jobs

  project     = var.project_id
  region      = var.region
  name        = "${var.environment}-${each.key}"
  description = "AI Studio ${var.environment} scheduled job: ${each.key}"
  schedule    = each.value.schedule
  time_zone   = each.value.time_zone

  http_target {
    # Cloud Run Job invoke URL — the v1 REST API endpoint that triggers an
    # execution. For arbitrary URL targets, use each.value.url directly.
    uri = each.value.target_type == "cloud_run_job" ? (
      "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${each.value.job_name}:run"
    ) : each.value.url

    http_method = each.value.http_method

    # Include body only when non-empty. body is a top-level string field on
    # http_target, not a nested block. Must be base64-encoded per the API spec;
    # callers should pass already-encoded values.
    body = each.value.body != "" ? each.value.body : null

    # OIDC token authenticates this Scheduler SA to the target. The audience
    # for Cloud Run Jobs must be the full invoke URL (not just the hostname).
    oidc_token {
      service_account_email = var.scheduler_sa_email
      audience = each.value.target_type == "cloud_run_job" ? (
        "https://${var.region}-run.googleapis.com/"
      ) : each.value.url
    }
  }

  # Retry on transient failures. Cloud Run Jobs are idempotent by design
  # (each execution is a fresh container), so retrying is safe.
  retry_config {
    retry_count          = 3
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
    max_backoff_duration = "3600s"
    max_doublings        = 5
  }

  # Preserve user-created pauses (e.g. temporarily disabling a job via the
  # console) across Terraform applies.
  lifecycle {
    ignore_changes = [paused]
  }
}
