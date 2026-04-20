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

variable "buckets" {
  type = map(object({
    name_suffix = string
    location    = optional(string, "us-west1")
    lifecycle_rules = optional(list(object({
      action             = string
      age_days           = optional(number)
      storage_class      = optional(string)
      num_newer_versions = optional(number)
    })), [])
    retention_days = optional(number, 0)
    versioning     = optional(bool, false)
  }))
  description = "GCS buckets to create (name -> spec)"
  default = {
    attachments = {
      name_suffix = "attachments"
      versioning  = true
    }
    repository-documents = {
      name_suffix = "repository-documents"
    }
    doc-processing-staging = {
      name_suffix = "doc-processing-staging"
    }
    audit-logs = {
      name_suffix = "audit-logs"
    }
  }
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
