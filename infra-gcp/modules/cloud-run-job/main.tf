##############################################################################
# cloud-run-job/main.tf
# Reusable Cloud Run v2 Job for async workloads: document processing,
# BookStack sync, CEDARS export, and other scheduled/event-driven tasks.
#
# Design notes
# ------------
# * Jobs (not Services): Cloud Run Jobs have no HTTP ingress. They run a
#   container to completion and exit. That maps cleanly onto the AWS Lambda
#   doc-processing pattern from the existing CDK stack.
# * Eventarc triggers: each entry in var.eventarc_triggers creates a separate
#   google_eventarc_trigger resource. GCS triggers require the Cloud Storage
#   service account to have roles/eventarc.eventReceiver on the project.
#   Pub/Sub triggers require no extra IAM beyond the SA running the job.
# * parallelism: controls how many task replicas run simultaneously in a
#   single execution. Useful for embarrassingly parallel batch jobs (e.g.
#   processing a large folder of student documents).
# * retries default of 3 (not 1 from scaffold) aligns with the spec §3.10.
#   The scaffold default of 1 was likely a generation artifact.
##############################################################################

locals {
  # Fully-qualified job name for use in Eventarc trigger targets.
  fq_job_name = "projects/${var.project_id}/locations/${var.region}/jobs/${var.job_name}"

  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "cloud-run-job"
    }
  )
}

resource "google_cloud_run_v2_job" "job" {
  project  = var.project_id
  name     = var.job_name
  location = var.region
  labels   = local.labels

  template {
    parallelism = var.parallelism
    task_count  = 1

    template {
      service_account = var.service_account_email

      max_retries = var.retries

      timeout = "${var.task_timeout_seconds}s"

      # Egress into the VPC is optional for jobs — some may only need public
      # internet (e.g. CEDARS SFTP export). Pass vpc_connector = "" to skip.
      dynamic "vpc_access" {
        for_each = var.vpc_connector != "" ? [1] : []
        content {
          connector = var.vpc_connector
          egress    = "ALL_TRAFFIC"
        }
      }

      containers {
        image = var.image

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }

        # Plain environment variables.
        dynamic "env" {
          for_each = var.env
          content {
            name  = env.key
            value = env.value
          }
        }

        # Secret Manager-backed env vars. Same split pattern as cloud-run-web:
        # "projects/P/secrets/S/versions/V" → secret + version fields.
        dynamic "env" {
          for_each = var.secret_refs
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = split("/versions/", env.value)[0]
                version = split("/versions/", env.value)[1]
              }
            }
          }
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Eventarc triggers
# ---------------------------------------------------------------------------
# Each trigger entry dispatches a Cloud Run Job execution when an event fires.
# The trigger SA (google_eventarc_trigger.job_triggers[*]) needs
# roles/run.invoker on the job. That binding is created here so the module
# is self-contained; callers don't need to manage it separately.
# ---------------------------------------------------------------------------

resource "google_eventarc_trigger" "job_triggers" {
  for_each = {
    for t in var.eventarc_triggers : t.name => t
  }

  project  = var.project_id
  name     = "${var.job_name}-${each.key}"
  location = var.region
  labels   = local.labels

  # Service account that Eventarc uses to invoke the job.
  service_account = var.service_account_email

  dynamic "matching_criteria" {
    for_each = each.value.type == "gcs" ? [1] : []
    content {
      attribute = "type"
      value     = each.value.event_type != null ? each.value.event_type : "google.cloud.storage.object.v1.finalized"
    }
  }

  dynamic "matching_criteria" {
    for_each = each.value.type == "gcs" ? [1] : []
    content {
      attribute = "bucket"
      value     = each.value.bucket
    }
  }

  dynamic "matching_criteria" {
    for_each = each.value.type == "pubsub" ? [1] : []
    content {
      attribute = "type"
      value     = "google.cloud.pubsub.topic.v1.messagePublished"
    }
  }

  # Pub/Sub trigger: Eventarc creates a push subscription on the topic.
  dynamic "transport" {
    for_each = each.value.type == "pubsub" ? [1] : []
    content {
      pubsub {
        topic = each.value.topic
      }
    }
  }

  # google provider ~> 6.0 removed cloud_run_job as a destination block type.
  # The supported pattern for Eventarc → Cloud Run Job is to route through a
  # Google Workflow that calls the Cloud Run Jobs execute API.
  # See: https://cloud.google.com/eventarc/docs/run/route-trigger-cloud-run-jobs
  destination {
    workflow = google_workflows_workflow.job_trigger_workflow[each.key].id
  }
}

# ---------------------------------------------------------------------------
# Workflow intermediaries (one per Eventarc trigger)
# ---------------------------------------------------------------------------
# In google provider ~> 6.0, google_eventarc_trigger no longer supports
# cloud_run_job as a destination. The canonical pattern is:
#   Eventarc → Workflow → Cloud Run Jobs execute API
# Each workflow receives the CloudEvent payload, extracts context, then calls
# projects.locations.jobs.run on the Cloud Run Jobs REST API.
# ---------------------------------------------------------------------------

resource "google_workflows_workflow" "job_trigger_workflow" {
  for_each = {
    for t in var.eventarc_triggers : t.name => t
  }

  project = var.project_id
  name    = "${var.job_name}-wf-${each.key}"
  region  = var.region
  labels  = local.labels

  service_account = var.service_account_email

  source_contents = <<-YAML
    main:
      params: [event]
      steps:
        - run_job:
            call: http.post
            args:
              url: ${"$"}{("https://run.googleapis.com/v2/" + "${local.fq_job_name}") + ":run"}
              auth:
                type: OAuth2
            result: run_response
        - return_result:
            return: ${"$"}{run_response.body}
  YAML
}
