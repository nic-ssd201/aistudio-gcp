output "job_name" {
  description = "Cloud Run Job resource name"
  value       = google_cloud_run_v2_job.job.name
}

output "job_fqn" {
  description = "Fully-qualified Cloud Run Job name (projects/P/locations/R/jobs/J) — used by Scheduler http_target URIs"
  value       = "projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.job.name}"
}

output "eventarc_trigger_names" {
  description = "Map of trigger key -> Eventarc trigger resource name"
  value       = { for k, t in google_eventarc_trigger.job_triggers : k => t.name }
}

# execution_name is not known at plan time for Cloud Run Jobs (executions
# are created on-demand). Leaving as null rather than a misleading value.
output "execution_name" {
  description = "Latest execution resource name (not known at plan time; use gcloud to inspect)"
  value       = null
}
