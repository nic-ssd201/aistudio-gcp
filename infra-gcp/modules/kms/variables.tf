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

variable "region" {
  type        = string
  description = "Primary GCP region"
  default     = "us-west1"
}

variable "keyring_name" {
  type        = string
  description = "KMS keyring name (default: aistudio-{env})"
  default     = ""
}

variable "keys" {
  type = map(object({
    rotation_period = optional(string, "7776000s") # 90 days
    purpose         = string
  }))
  description = "KMS keys to create (name -> spec with rotation_period and purpose)"
  default = {
    alloydb    = { purpose = "AlloyDB CMEK" }
    storage    = { purpose = "Cloud Storage CMEK" }
    secrets    = { purpose = "Secret Manager CMEK" }
    artifacts  = { purpose = "Artifact Registry CMEK" }
    audit-logs = { purpose = "Audit log bucket CMEK" }
  }
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
