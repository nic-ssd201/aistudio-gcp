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

variable "kms_key" {
  type        = string
  description = "KMS key resource name for CMEK"
}

variable "secrets" {
  type = map(object({
    description        = string
    rotation_period    = optional(string, "")
    accessor_sa_emails = optional(list(string), [])
  }))
  description = "Secrets to create (name -> spec); values set via CLI"
  default     = {}
}

variable "region" {
  type        = string
  description = "GCP region for user-managed replication replica (required for CMEK; automatic replication does not support KMS)"
  default     = "us-west1"
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
