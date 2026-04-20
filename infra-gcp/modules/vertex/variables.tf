variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "Primary GCP region"
  default     = "us-west1"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev|staging|prod)"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "model_armor_templates" {
  # Map of template_id (string) → config object (currently a marker; filter config is
  # hardcoded to SEVERITY_HIGH per spec §3.12 — pass an empty map {} to create none,
  # or a map with keys naming each template to create).
  type        = map(any)
  description = "Model Armor templates to create. Map keys become template IDs."
  default = {
    "aistudio-default" = {}
  }
}

variable "enable_claude_models" {
  type        = bool
  description = "Signal that Claude models on Vertex are desired. Requires org-level approval + Nic's H2 quota request. This module enables the API only; model endpoints are managed separately."
  default     = false
}

variable "cloud_run_sa_email" {
  type        = string
  description = "Service account email for Cloud Run web service (from sa-factory output). Granted roles/aiplatform.user."
  default     = ""
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
