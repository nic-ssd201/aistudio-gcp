##############################################################################
# cloud-run-web/main.tf
# Deploys the AI Studio Next.js SSR app as a Cloud Run v2 service.
#
# Design notes
# ------------
# * INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER: Cloud Run accepts traffic only
#   from the Global HTTPS LB (and the LB's health checks). Direct internet
#   access is blocked, forcing all traffic through Cloud Armor + CDN.
# * cpu_always_allocated=true in prod prevents cold starts on user requests
#   at the cost of billing idle instances. Acceptable trade-off given typical
#   K-12 usage patterns (bell-curve load, unacceptable latency spikes).
# * Blue/green in prod: we deliberately do NOT pin 100% → latest. The env
#   composition layer must supply `traffic_revision` with an explicit revision
#   name after smoke-testing a new deployment. Non-prod environments always
#   route to latest for frictionless iteration.
# * Secret injection: each key in var.secret_refs becomes an env var whose
#   value is drawn from Secret Manager at container startup — no secret ever
#   touches a Terraform state file or environment variable in plaintext.
##############################################################################

locals {
  service_name = "aistudio-${var.environment}-web"

  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "cloud-run-web"
    }
  )

  # Resource Manager tags — every taggable GCP resource in this project must
  # carry these so tag-conditioned IAM bindings in sa-factory resolve correctly.
  resource_tags = {
    "aistudio/environment" = var.environment
    "aistudio/managed-by"  = "terraform"
  }
}

resource "google_cloud_run_v2_service" "web" {
  project  = var.project_id
  name     = local.service_name
  location = var.region

  # Block all direct-internet ingress; only the Global HTTPS LB may route
  # traffic here. IAP and internal services can also reach this if needed.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  labels = local.labels

  template {
    service_account = var.service_account_email

    # Scaling boundaries — passed in per-environment from tfvars.
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    # CPU always allocated in prod to eliminate cold starts; idle billing is
    # acceptable. In dev/staging this is false to save cost.
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    annotations = {
      "autoscaling.knative.dev/minScale" = tostring(var.min_instances)
      "autoscaling.knative.dev/maxScale" = tostring(var.max_instances)
    }

    # Egress to the shared VPC so Cloud Run can reach AlloyDB, Secret Manager
    # endpoints, and other VPC-private services.
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
        # cpu_idle=false means CPU is allocated even when not processing requests.
        # Equivalent to cpu_always_allocated for cold-start prevention.
        cpu_idle          = !var.cpu_always_allocated
        startup_cpu_boost = true
      }

      # Plain environment variables (non-sensitive).
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      # Secret-backed environment variables. Each value in var.secret_refs is
      # the full Secret Manager resource path:
      #   "projects/PROJECT/secrets/SECRET_NAME/versions/VERSION"
      # Callers should supply the version-pinned ref from secrets module output
      # rather than "latest" so deployments are reproducible.
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

      # Startup probe: Cloud Run waits for this to succeed before routing
      # traffic. Using /api/health keeps it app-specific (Next.js route).
      startup_probe {
        http_get {
          path = var.health_check_path
          port = var.port
        }
        initial_delay_seconds = 10
        period_seconds        = 5
        failure_threshold     = 10
        timeout_seconds       = 3
      }

      # Liveness probe: if this fails, Cloud Run restarts the container.
      liveness_probe {
        http_get {
          path = var.health_check_path
          port = var.port
        }
        period_seconds    = 30
        failure_threshold = 3
        timeout_seconds   = 3
      }

      ports {
        container_port = var.port
      }
    }

    max_instance_request_concurrency = var.concurrency
  }

  # ---------------------------------------------------------------------------
  # Traffic policy
  # ---------------------------------------------------------------------------
  # Non-prod: always route 100% to the latest revision. Blue/green is not
  # needed in dev/staging — "it deploys to latest" is the expected behaviour.
  #
  # Prod: traffic stays on the explicitly named revision supplied via
  # var.traffic_revision. The env composition layer updates this variable after
  # smoke-testing a new revision, making the cutover intentional and auditable.
  # ---------------------------------------------------------------------------

  dynamic "traffic" {
    for_each = var.environment != "prod" ? [1] : []
    content {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
  }

  dynamic "traffic" {
    for_each = var.environment == "prod" && var.traffic_revision != "" ? [1] : []
    content {
      type     = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
      revision = var.traffic_revision
      percent  = 100
    }
  }

  lifecycle {
    # Ignore image changes so Terraform plan doesn't flag every new CI push as
    # a drift. Image updates are managed via the CI pipeline directly.
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }
}
