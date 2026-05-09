##############################################################################
# cloud-tasks-queue/main.tf
# Single Cloud Tasks queue for async dispatch into a Cloud Run Worker.
#
# Configuration philosophy: keep rate limits aggressive-by-default, retry
# windows generous-by-default. The producer (app) is trusted to enqueue
# correctly; the queue is here to absorb bursts and apply backoff on
# transient failures, not to gate volume from a runaway sender.
##############################################################################

locals {
  labels = merge(
    var.labels,
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "cloud-tasks-queue"
    }
  )
}

resource "google_cloud_tasks_queue" "queue" {
  project  = var.project_id
  name     = var.queue_name
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.max_dispatches_per_second
    max_concurrent_dispatches = var.max_concurrent_dispatches
  }

  retry_config {
    max_attempts  = var.max_attempts
    min_backoff   = var.min_backoff
    max_backoff   = var.max_backoff
    max_doublings = var.max_doublings
  }
}
