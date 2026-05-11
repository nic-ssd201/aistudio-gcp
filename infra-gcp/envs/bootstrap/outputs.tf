# Outputs consumed by downstream env roots via data "terraform_remote_state" "bootstrap"

output "shared_project_id" {
  description = "Shared (host) project ID — e.g. ssd201-aistudio-shared"
  value       = module.bootstrap.shared_project_id
}

output "shared_project_number" {
  description = "Shared project number (needed for WIF principalSet URNs)"
  value       = module.bootstrap.shared_project_number
}

output "state_bucket_name" {
  description = "GCS bucket name for Terraform state"
  value       = module.bootstrap.state_bucket_name
}

output "wif_pool_name" {
  description = "Workload Identity Pool resource name"
  value       = module.bootstrap.wif_pool_name
}

output "github_provider_name" {
  description = "GitHub Actions provider resource name"
  value       = module.bootstrap.github_provider_name
}

output "openclaw_provider_name" {
  description = "OpenClaw local OIDC provider resource name"
  value       = module.bootstrap.openclaw_provider_name
}

output "terraform_runner_sa_email" {
  description = "Terraform runner service account email"
  value       = module.bootstrap.terraform_runner_sa_email
}

output "openclaw_runtime_sa_email" {
  description = "OpenClaw runtime service account email"
  value       = module.bootstrap.openclaw_runtime_sa_email
}

output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository URI"
  value       = module.bootstrap.artifact_registry_repository
}

output "breakglass_channel_id" {
  description = "Cloud Monitoring notification channel ID for the breakglass email. Pass to the observability module or use as a fallback in additional budgets."
  value       = module.bootstrap.breakglass_channel_id
}

output "budget_names" {
  description = "Map of budget display name → budget resource name"
  value       = module.bootstrap.budget_names
}
