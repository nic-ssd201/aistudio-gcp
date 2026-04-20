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

variable "service_accounts" {
  type = map(object({
    display_name = string
    description  = string
    roles        = list(string)
  }))
  description = "Service accounts to create (name -> spec)"
  default     = {}
}

variable "role_bindings" {
  type        = any
  description = "IAM role bindings with tag conditions"
  default     = []
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}

variable "run_invoker_bindings" {
  description = "Cross-cutting bindings: Cloud Run service/job invoker permissions for other workloads' SAs (scheduler → job, service → service, etc.)."
  type = list(object({
    target_kind = string # "service" | "job"
    target_name = string # Cloud Run service/job name (short name, not full resource name)
    location    = string # region (e.g., "us-west1")
    project_id  = string # project hosting the target
    invoker_sa  = string # member string — "serviceAccount:<email>"
  }))
  default = []

  validation {
    condition     = alltrue([for b in var.run_invoker_bindings : contains(["service", "job"], b.target_kind)])
    error_message = "target_kind must be 'service' or 'job'."
  }
}

variable "eventarc_receiver_bindings" {
  description = "Cross-cutting bindings: roles/eventarc.eventReceiver on a project for specific members (typically GCS service agents for bucket-triggered jobs)."
  type = list(object({
    project_id = string
    member     = string # e.g., "serviceAccount:service-PROJECT_NUMBER@gs-project-accounts.iam.gserviceaccount.com"
  }))
  default = []
}
