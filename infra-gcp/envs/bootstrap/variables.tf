# Bootstrap env root variables.
# Supply values via a per-env tfvars file:
#   terraform apply -var-file=dev.tfvars
#   terraform apply -var-file=staging.tfvars
#   terraform apply -var-file=prod.tfvars

variable "env" {
  type        = string
  description = "Environment being bootstrapped (dev | staging | prod). Used to label resources and scope the billing budget."

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "host_project_id" {
  type        = string
  description = "Pre-created aistudio-shared GCP project ID. Terraform adopts this project via a data source — never creates or destroys it."
}

variable "env_project_id" {
  type        = string
  description = "Pre-created env GCP project ID (e.g. aistudio-dev). Scopes the billing budget to this project."
}

variable "org_id" {
  type        = string
  description = "GCP organization ID (from: gcloud organizations list). Required for the org-level audit log sink."
}

variable "billing_account" {
  type        = string
  description = "GCP billing account ID (format: XXXXXX-XXXXXX-XXXXXX). Required for google_billing_budget resources."
}

variable "region" {
  type        = string
  description = "Primary GCP region (used for state bucket location and provider default)"
  default     = "us-west1"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository slug for WIF subject claim (e.g. psd401/aistudio)"
  default     = "psd401/aistudio"
}

variable "openclaw_local_issuer" {
  type        = string
  description = "OIDC issuer URL for OpenClaw local runtime"
  default     = "http://localhost:18789"
}

variable "state_bucket_name" {
  type        = string
  description = "GCS bucket name for Terraform state (globally unique)"
  default     = "aistudio-tfstate-shared"
}

variable "breakglass_email" {
  type        = string
  description = "Email address for the breakglass notification channel. Receives budget alerts on day 1, before observability channels exist."
}

variable "budget_amount_usd" {
  type        = number
  description = "Monthly budget ceiling in USD for the env project."
}

variable "budget_threshold_percents" {
  type        = list(number)
  description = "Budget alert threshold percentages (e.g. [0.5, 0.8, 1.0] = 50/80/100% current-spend)."
  default     = [0.5, 0.8, 1.0]
}

variable "budget_notification_channels" {
  type        = list(string)
  description = "Optional list of Cloud Monitoring notification channel IDs to wire into the budget. If empty, the breakglass email channel is used automatically."
  default     = []
}

variable "labels" {
  type        = map(string)
  description = "Extra resource labels applied to all bootstrap resources"
  default     = {}
}
