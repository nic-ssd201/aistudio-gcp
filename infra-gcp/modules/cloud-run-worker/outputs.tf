output "service_name" {
  description = "Cloud Run service name"
  value       = google_cloud_run_v2_service.worker.name
}

output "service_url" {
  description = "Service URL (HTTPS endpoint Cloud Tasks / Cloud Scheduler dispatch to)"
  value       = google_cloud_run_v2_service.worker.uri
}
