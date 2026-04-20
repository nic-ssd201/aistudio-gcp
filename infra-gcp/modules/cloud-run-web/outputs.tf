output "service_url" {
  description = "Stable HTTPS URL for the Cloud Run service (populated after first deployment)"
  value       = google_cloud_run_v2_service.web.uri
}

output "service_name" {
  description = "Cloud Run service resource name (projects/P/locations/R/services/S)"
  value       = google_cloud_run_v2_service.web.name
}

output "latest_revision_name" {
  description = "Latest revision name — use this value as var.traffic_revision when promoting to prod"
  value       = google_cloud_run_v2_service.web.latest_ready_revision
}
