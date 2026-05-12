##############################################################################
# cloud-run-worker/main.tf
# Cloud Run v2 Service for HTTP-receiving background workers (document
# processor, future BookStack sync API, etc.).
#
# How this differs from cloud-run-web:
#   * INGRESS_TRAFFIC_INTERNAL_ONLY — workers only accept traffic from Google
#     services (Cloud Tasks, Cloud Scheduler, Eventarc) and from VPC peers.
#     There's no LB / Cloud Armor in front; the OIDC check at the
#     application layer is the auth boundary.
#   * concurrency defaults to 1 — each request is long-running and
#     CPU/memory-bound; queueing in front (Cloud Tasks) is the right model.
#   * Configurable request timeout (up to Cloud Run's 60-min cap).
#   * No blue/green traffic split — workers can route 100% to latest because
#     a botched deploy that 500s just causes Cloud Tasks to retry, no user
#     impact.
##############################################################################

locals {
  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "cloud-run-worker"
    }
  )
}

resource "google_cloud_run_v2_service" "worker" {
  project  = var.project_id
  name     = var.service_name
  location = var.region

  # Internal-only: only callable from within the project + Google services
  # (Cloud Tasks, Cloud Scheduler). No public internet, no LB.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  labels              = local.labels
  deletion_protection = var.deletion_protection

  template {
    service_account = var.service_account_email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    annotations = {
      "autoscaling.knative.dev/minScale" = tostring(var.min_instances)
      "autoscaling.knative.dev/maxScale" = tostring(var.max_instances)
    }

    timeout = "${var.request_timeout_seconds}s"

    vpc_access {
      connector = var.vpc_connector
      egress    = "ALL_TRAFFIC"
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        # CPU only when handling a request — workers don't need to be warm
        # in between, and idle billing on small fleets gets noisy.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

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

      startup_probe {
        http_get {
          path = var.health_check_path
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 10
        timeout_seconds       = 3
      }

      ports {
        container_port = 8080
      }
    }

    max_instance_request_concurrency = var.concurrency
  }

  # Workers always route 100% to latest; no blue/green needed (failed deploys
  # just cause Cloud Tasks to retry against the prior revision until the new
  # one is ready, which is the right behaviour for async work).
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    # Image updates land via the CI pipeline; Terraform shouldn't fight them.
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }
}
