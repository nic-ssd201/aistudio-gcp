variable "name" {
  description = "Workload name. Becomes the SA account_id as 'sa-<name>'. Must be 2-24 chars, lowercase alphanumeric + hyphens, must not start/end with hyphen."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,22}[a-z0-9]$", var.name))
    error_message = "name must be 2-24 chars, lowercase alphanumeric + hyphens, not starting or ending with a hyphen."
  }
}

variable "project_id" {
  description = "GCP project that will own this service account."
  type        = string

  validation {
    condition     = length(var.project_id) >= 6 && length(var.project_id) <= 30
    error_message = "project_id must be 6-30 chars."
  }
}

variable "environment" {
  description = "Deployment environment. Applied as a label for audit."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "description" {
  description = "Free-text description shown in the GCP console."
  type        = string
  default     = ""
}

variable "storage_buckets" {
  description = "GCS buckets to bind scoped IAM roles on."
  type = list(object({
    bucket = string
    role   = string
  }))
  default = []
}

variable "secrets" {
  description = "Secret Manager secrets to bind scoped IAM roles on."
  type = list(object({
    secret_id = string
    role      = string
  }))
  default = []
}

variable "sql_instances" {
  description = "Cloud SQL instances to grant project-level role, scoped via IAM condition to the named instance."
  type = list(object({
    instance = string
    role     = string
  }))
  default = []
}

variable "pubsub_topics" {
  description = "Pub/Sub topics to bind scoped IAM roles on."
  type = list(object({
    topic = string
    role  = string
  }))
  default = []
}

variable "pubsub_subscriptions" {
  description = "Pub/Sub subscriptions to bind scoped IAM roles on."
  type = list(object({
    subscription = string
    role         = string
  }))
  default = []
}

variable "vertex_ai_enabled" {
  description = "Grant roles/aiplatform.user at project level."
  type        = bool
  default     = false
}

variable "cloud_logging_enabled" {
  description = "Grant roles/logging.logWriter."
  type        = bool
  default     = true
}

variable "cloud_monitoring_enabled" {
  description = "Grant roles/monitoring.metricWriter."
  type        = bool
  default     = true
}

variable "cloud_trace_enabled" {
  description = "Grant roles/cloudtrace.agent."
  type        = bool
  default     = true
}

variable "additional_project_roles" {
  description = "Escape hatch for roles not covered by the structured inputs. Each entry may include an IAM condition for tighter scoping."
  type = list(object({
    project = string
    role    = string
    condition = optional(object({
      title       = string
      description = optional(string)
      expression  = string
    }))
  }))
  default = []
}

variable "labels" {
  description = "Additional labels to apply to the service account. `environment` and `managed-by` are always added automatically."
  type        = map(string)
  default     = {}
}
