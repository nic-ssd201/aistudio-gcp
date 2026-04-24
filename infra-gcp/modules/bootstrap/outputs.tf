output "state_bucket_name" {
  description = "GCS bucket name for Terraform state"
  value       = google_storage_bucket.state.name
}

output "wif_pool_name" {
  description = "Workload Identity Pool resource name"
  value       = google_iam_workload_identity_pool.main.name
}

output "github_provider_name" {
  description = "GitHub Actions provider resource name"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "openclaw_provider_name" {
  description = "OpenClaw local OIDC provider resource name"
  value       = google_iam_workload_identity_pool_provider.openclaw.name
}

output "terraform_runner_sa_email" {
  description = "Terraform runner service account email"
  value       = google_service_account.terraform_runner.email
}

output "openclaw_runtime_sa_email" {
  description = "OpenClaw runtime service account email"
  value       = google_service_account.openclaw_runtime.email
}

output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository URI"
  value       = "${var.state_bucket_location}-docker.pkg.dev/${data.google_project.shared.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}

output "shared_project_id" {
  description = "aistudio-shared project ID"
  value       = data.google_project.shared.project_id
}

output "shared_project_number" {
  description = "aistudio-shared project number (needed for WIF principalSet URNs)"
  value       = data.google_project.shared.number
}

output "budget_names" {
  description = "Map of budget display name → budget resource name"
  value       = { for k, b in google_billing_budget.budgets : k => b.name }
}

output "breakglass_channel_id" {
  description = "Monitoring notification channel ID for the breakglass email address. Pass to observability module as a fallback channel or pre-seed budget alerts before observability's first apply."
  value       = google_monitoring_notification_channel.breakglass.id
}
