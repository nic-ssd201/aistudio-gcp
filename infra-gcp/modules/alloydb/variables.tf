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

variable "vpc_self_link" {
  type        = string
  description = "VPC self-link from network module"
}

variable "psa_range" {
  type        = string
  description = "Private Services Access IP range"
}

variable "kms_key" {
  type        = string
  description = "KMS key resource name for CMEK"
}

variable "cluster_name" {
  type        = string
  description = "AlloyDB cluster name (default: aistudio-{env})"
  default     = ""
}

variable "cpu_count" {
  type        = number
  description = "CPU count for primary instance (dev: 2, staging: 2, prod: 4)"
  default     = 2
  validation {
    condition     = contains([2, 4, 8, 16], var.cpu_count)
    error_message = "cpu_count must be 2, 4, 8, or 16."
  }
}

variable "initial_user_password_secret" {
  type        = string
  description = "Secret Manager reference for initial postgres user password"
}

variable "enable_read_pool" {
  type        = bool
  description = "Enable read-only instance pool (recommended for prod)"
  default     = false
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
