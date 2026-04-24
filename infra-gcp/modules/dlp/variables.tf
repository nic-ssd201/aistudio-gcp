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

variable "job_triggers" {
  type = list(object({
    # GCS bucket name (without gs:// prefix) to scan on OBJECT_FINALIZE.
    bucket = string
  }))
  description = "GCS buckets to attach DLP job triggers to. Typically: attachments + repository-documents buckets from storage module outputs."
  default     = []
}

variable "findings_pubsub_topic" {
  type        = string
  description = "Pub/Sub topic ID to publish DLP findings to. Required if create_findings_topic = false. Format: projects/<project>/topics/<topic>"
  default     = ""
}

variable "create_findings_topic" {
  type        = bool
  description = "If true, create the ferpa-dlp-findings Pub/Sub topic in this module. Set false if the topic is owned by another module."
  default     = true
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
