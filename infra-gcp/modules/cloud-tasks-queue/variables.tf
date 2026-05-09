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
  description = "Cloud Tasks queue location"
  default     = "us-west1"
}

variable "queue_name" {
  type        = string
  description = "Queue name (full name; the module does NOT prepend env)"
}

# Rate limits — kept conservative by default so a runaway producer can't
# DoS the worker. Override per-queue in the env composition.
variable "max_dispatches_per_second" {
  type        = number
  description = "Token-bucket rate cap on outbound HTTP dispatches"
  default     = 10
}

variable "max_concurrent_dispatches" {
  type        = number
  description = "Hard cap on simultaneously-in-flight HTTP dispatches"
  default     = 5
}

variable "max_attempts" {
  type        = number
  description = "Retry attempts before the task moves to permanent failure (1 = no retry; 100 = effectively forever)"
  default     = 5
}

variable "min_backoff" {
  type        = string
  description = "Minimum exponential backoff between retries (Go duration string)"
  default     = "10s"
}

variable "max_backoff" {
  type        = string
  description = "Maximum exponential backoff between retries"
  default     = "300s"
}

variable "max_doublings" {
  type        = number
  description = "How many times the retry interval doubles before plateauing at max_backoff"
  default     = 4
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
