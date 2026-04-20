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
  description = "Cloud Scheduler region (must match Cloud Run job region)"
  default     = "us-west1"
}

variable "scheduler_sa_email" {
  type        = string
  description = "Service account email used for OIDC auth on http_target calls (from iam/sa-factory output)"
}

variable "jobs" {
  description = <<-EOT
    Map of scheduler job name to job spec. Each job spec object:
      schedule    - cron expression (required)
      time_zone   - IANA tz (default: "America/Los_Angeles")
      target_type - "cloud_run_job" | "url"
      job_name    - Cloud Run Job name (required when target_type = "cloud_run_job")
      url         - explicit URL (required when target_type = "url")
      http_method - HTTP method (default: "POST")
      body        - optional base64-encoded request body
    EOT
  type = map(object({
    schedule    = string
    time_zone   = optional(string, "America/Los_Angeles")
    target_type = string
    job_name    = optional(string, "")
    url         = optional(string, "")
    http_method = optional(string, "POST")
    body        = optional(string, "")
  }))
  default = {}
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
