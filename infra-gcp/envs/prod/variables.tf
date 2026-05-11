# §6.1: Projects are pre-created manually. env_project_id is a plain string input —
# Terraform never manages project lifecycle.
# §6.6: billing_account, org_id, host_project_id, and budget_notification_channels
# have moved to envs/bootstrap. Apply envs/bootstrap first.

variable "env_project_id" {
  type        = string
  description = "Env GCP project ID — e.g. ssd201-aistudio-prod (pre-created manually)"
}

variable "region" {
  type        = string
  description = "Primary GCP region"
  default     = "us-west1"
}

variable "environment" {
  type        = string
  description = "Environment name — must match directory (prod)"
  default     = "prod"
  validation {
    condition     = var.environment == "prod"
    error_message = "This env root is locked to environment = prod."
  }
}

variable "domain_name" {
  type        = string
  description = "FQDN for the LB managed cert (e.g. aistudio.sunnysideschools.org)"
}

variable "container_image" {
  type        = string
  description = "Artifact Registry image URI for the web service — pin to a release tag for prod"
}

variable "doc_processor_image" {
  type        = string
  description = "Artifact Registry image URI for the document-processor Cloud Run worker — pin to a release tag for prod"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
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
  description = "Monthly budget ceiling in USD for this env (prod default: 5000)"
  default     = 5000
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

# Cloud Run scaling — prod: min=2, CPU always-on
variable "cloud_run_min_instances" {
  type        = number
  description = "Cloud Run minimum instances (prod: 2 for HA — two zones)"
  default     = 2
}

variable "cloud_run_max_instances" {
  type        = number
  description = "Cloud Run maximum instances (prod: 100)"
  default     = 100
}

# VPC-SC: §6.4 — false on first apply; promote to true after 7-day clean dry-run + Vault review
variable "enable_vpc_sc_enforce" {
  type        = bool
  description = "VPC-SC enforce mode. DANGER: set true only after clean dry-run window + Vault signoff."
  default     = false
}
