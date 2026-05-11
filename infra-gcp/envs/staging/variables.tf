# §6.1: Projects are pre-created manually. env_project_id is a plain string input —
# Terraform never manages project lifecycle.
# §6.6: billing_account, org_id, host_project_id, and budget_notification_channels
# have moved to envs/bootstrap. Apply envs/bootstrap first.

variable "env_project_id" {
  type        = string
  description = "Env GCP project ID — e.g. ssd201-aistudio-staging (pre-created manually)"
}

variable "region" {
  type        = string
  description = "Primary GCP region"
  default     = "us-west1"
}

variable "environment" {
  type        = string
  description = "Environment name — must match directory (staging)"
  default     = "staging"
  validation {
    condition     = var.environment == "staging"
    error_message = "This env root is locked to environment = staging."
  }
}

variable "domain_name" {
  type        = string
  description = "FQDN for the LB managed cert (e.g. staging-aistudio.sunnysideschools.org)"
}

variable "container_image" {
  type        = string
  description = "Artifact Registry image URI for the web service"
}

variable "doc_processor_image" {
  type        = string
  description = "Artifact Registry image URI for the document-processor Cloud Run worker"
  # Placeholder so first apply succeeds before the image is built — Terraform
  # ignores image changes thereafter (cloud-run-worker module sets
  # lifecycle.ignore_changes), so the real image lands via CI.
  default = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "vpc_sc_access_policy_name" {
  type        = string
  description = "Numeric org-level VPC-SC access policy name"
}

variable "workspace_oidc_client_id" {
  type        = string
  description = "Google Workspace OIDC client ID for Identity Platform provider"
}

variable "workspace_oidc_client_secret" {
  type        = string
  description = "Google Workspace OIDC client secret — plaintext value; source from Secret Manager at plan time"
  sensitive   = true
}

variable "budget_amount_usd" {
  type        = number
  description = "Monthly budget ceiling in USD for this env (staging default: 2000)"
  default     = 2000
}

variable "alert_channels" {
  type = list(object({
    display_name = string
    type         = string
    labels       = optional(map(string), {})
    sensitive_labels = optional(object({
      auth_token  = optional(string, "")
      service_key = optional(string, "")
      password    = optional(string, "")
    }), {})
  }))
  description = "Observability alert notification channels (PagerDuty, Telegram, Google Chat)"
  sensitive   = true
  default     = []
}

# Cloud Run scaling — staging: min=1 for always-warm, CPU always-on
variable "cloud_run_min_instances" {
  type        = number
  description = "Cloud Run minimum instances (staging: 1)"
  default     = 1
}

variable "cloud_run_max_instances" {
  type        = number
  description = "Cloud Run maximum instances (staging: 20)"
  default     = 20
}

# VPC-SC
variable "enable_vpc_sc_enforce" {
  type        = bool
  description = "VPC-SC enforce mode. Keep false until 7-day dry-run is clean."
  default     = false
}
