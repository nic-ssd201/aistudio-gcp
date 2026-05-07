output "perimeter_name" {
  description = "Full resource name of the service perimeter"
  value       = google_access_context_manager_service_perimeter.this.name
}

output "perimeter_status" {
  description = "Enforcement status: dry-run or enforced"
  value       = var.enforce_mode ? "enforced" : "dry-run"
}

output "violation_count_metric" {
  description = "Log-based metric name for VPC-SC violations (protoPayload.metadata.vpcServiceControlsUniqueId). Read from observability module output for CI gate integration."
  value       = "logging.googleapis.com/user/aistudio_vpc_sc_violations"
}

output "enforce_mode" {
  description = "Whether the perimeter is in enforce mode"
  value       = var.enforce_mode
}
