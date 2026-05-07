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

variable "job_name" {
  type        = string
  description = "Cloud Run Job name"
}

variable "service_account_email" {
  type        = string
  description = "Cloud Run Job service account email"
}

variable "image" {
  type        = string
  description = "Container image URI"
}

variable "vpc_connector" {
  type        = string
  description = "Serverless VPC Connector resource name (optional)"
  default     = ""
}

variable "task_timeout_seconds" {
  type        = number
  description = "Task timeout in seconds"
  default     = 3600
}

variable "retries" {
  type        = number
  description = "Number of retries on failure (spec §3.10 default: 3)"
  default     = 3
}

variable "parallelism" {
  type        = number
  description = "Number of task replicas to run simultaneously in a single execution"
  default     = 1
}

variable "cpu" {
  type        = string
  description = "vCPU limit per task container"
  default     = "2"
}

variable "memory" {
  type        = string
  description = "Memory limit per task container"
  default     = "2Gi"
}

variable "secret_refs" {
  type        = map(string)
  description = "Map of environment variable name to Secret Manager reference"
  default     = {}
}

variable "env" {
  type        = map(string)
  description = "Plain environment variables"
  default     = {}
}

variable "eventarc_triggers" {
  type        = any
  description = "Eventarc trigger configurations"
  default     = []
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
