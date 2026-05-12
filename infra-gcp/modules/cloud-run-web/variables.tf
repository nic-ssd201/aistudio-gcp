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
  description = "Serverless VPC Connector resource name"
}

variable "min_instances" {
  type        = number
  description = "Minimum instances (dev: 0, staging: 0, prod: 1)"
  default     = 0
}

variable "max_instances" {
  type        = number
  description = "Maximum instances (dev: 5, staging: 20, prod: 100)"
  default     = 5
}

variable "concurrency" {
  type        = number
  description = "Concurrency per instance"
  default     = 80
}

variable "cpu_always_allocated" {
  type        = bool
  description = "Allocate CPU always (prod: true)"
  default     = false
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

variable "cpu" {
  type        = string
  description = "vCPU limit per container (e.g. '2')"
  default     = "2"
}

variable "memory" {
  type        = string
  description = "Memory limit per container (e.g. '2Gi')"
  default     = "2Gi"
}

variable "port" {
  type        = number
  description = "Container port the Next.js app listens on"
  default     = 3000
}

variable "health_check_path" {
  type        = string
  description = "HTTP path for startup and liveness probes"
  default     = "/api/health"
}

variable "traffic_revision" {
  type        = string
  description = "Prod only: explicit revision name to receive 100% of traffic (blue/green cutover). Leave empty in non-prod."
  default     = ""
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
