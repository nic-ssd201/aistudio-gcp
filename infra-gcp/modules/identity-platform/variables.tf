variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev|staging|prod)"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "tenant_display_name" {
  type        = string
  description = "Display name for the Identity Platform tenant (e.g., SSD Staff)"
}

variable "authorized_domains" {
  type        = list(string)
  description = "Authorized domains for Identity Platform (e.g., [\"aistudio-prod.ssd.example\"])"
  default     = []
}

variable "oidc_providers" {
  type = list(object({
    display_name = string
    client_id    = string
    issuer       = string
    # client_secret_value is the resolved plaintext value from Secret Manager.
    # Source it via data "google_secret_manager_secret_version" in the env composition
    # layer and pass it in. NEVER hardcode this value.
    client_secret_value = string
  }))
  description = "OIDC provider configurations. Workspace SSO issuer = https://accounts.google.com."
  default     = []
  sensitive   = true
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
