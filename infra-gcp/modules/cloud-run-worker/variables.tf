variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "deletion_protection" {
  type        = bool
  description = "Terraform-side deletion protection. Default true (matches Google provider default) — set false in dev envs so failed revisions can be destroyed + recreated via `terraform apply` without manual gcloud intervention."
  default     = true
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

variable "service_name" {
  type        = string
  description = "Cloud Run service name (full name; the module does NOT prepend env)"
}

variable "service_account_email" {
  type        = string
  description = "Cloud Run service account email"
}

variable "image" {
  type        = string
  description = "Container image URI (Artifact Registry)"
}

variable "vpc_connector" {
  type        = string
  description = "Serverless VPC Connector resource name (required — workers typically reach AlloyDB)"
}

variable "min_instances" {
  type        = number
  description = "Minimum instances (default 0 — workers wake on incoming task)"
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Maximum instances (cap concurrent task processing)"
  default     = 10
}

variable "concurrency" {
  type        = number
  description = "Concurrent in-flight requests per instance. Workers default to 1 because each request is long-running and CPU/memory-intensive."
  default     = 1
}

variable "request_timeout_seconds" {
  type        = number
  description = "HTTP request timeout (max 3600 = 60 min on Cloud Run)"
  default     = 1800
  validation {
    condition     = var.request_timeout_seconds > 0 && var.request_timeout_seconds <= 3600
    error_message = "request_timeout_seconds must be > 0 and <= 3600 (Cloud Run hard cap)."
  }
}

variable "secret_refs" {
  type        = map(string)
  description = "Map of environment variable name to Secret Manager version reference"
  default     = {}
}

variable "env" {
  type        = map(string)
  description = "Plain environment variables"
  default     = {}
}

variable "cpu" {
  type        = string
  description = "vCPU limit per container"
  default     = "1"
}

variable "memory" {
  type        = string
  description = "Memory limit per container"
  default     = "2Gi"
}

variable "health_check_path" {
  type        = string
  description = "HTTP path for startup and liveness probes"
  default     = "/healthz"
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
