output "job_names" {
  description = "Map of job key -> Cloud Scheduler job resource name"
  value       = { for k, j in google_cloud_scheduler_job.jobs : k => j.name }
}

output "job_ids" {
  description = "Map of job key -> Cloud Scheduler job fully-qualified ID"
  value       = { for k, j in google_cloud_scheduler_job.jobs : k => j.id }
}

output "job_schedules" {
  description = "Map of job key -> cron schedule string (for documentation/audit)"
  value       = { for k, j in google_cloud_scheduler_job.jobs : k => j.schedule }
}
