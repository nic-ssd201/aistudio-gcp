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
  description = "Cloud Run service region (used for Serverless NEG)"
  default     = "us-west1"
}

# ---------------------------------------------------------------------------
# Backend: Cloud Run service
# ---------------------------------------------------------------------------

variable "cloud_run_service_name" {
  type        = string
  description = "Cloud Run service name (from cloud-run-web module output: service_name)"
}

variable "cloud_run_region" {
  type        = string
  description = "Region where the Cloud Run service lives (usually same as var.region)"
  default     = "us-west1"
}

# Kept for README compatibility; the LB resolves the backend via Serverless NEG.
# Callers may pass cloud-run-web.outputs.service_url here for documentation/output purposes.
variable "backend_service_url" {
  type        = string
  description = "Cloud Run service URL (informational; routing goes through Serverless NEG)"
  default     = ""
}

# ---------------------------------------------------------------------------
# TLS / Certificate Manager
# ---------------------------------------------------------------------------

variable "domains" {
  type        = list(string)
  description = "Fully-qualified domain names for the managed SSL certificate (e.g. [\"aistudio.ssd.example\"])"
}

# Kept for single-domain backward compat with Haiku scaffold.
variable "certificate_domain" {
  type        = string
  description = "Single domain alias — prefer var.domains for multi-domain certs. If set and var.domains is empty, used as the sole domain."
  default     = ""
}

# ---------------------------------------------------------------------------
# Cloud Armor
# ---------------------------------------------------------------------------

variable "rate_limit_rpm" {
  type        = number
  description = "Rate limit in requests-per-minute per source IP (Cloud Armor rule)"
  default     = 1000
}

variable "geo_restriction_countries" {
  type        = list(string)
  description = "ISO 3166-1 alpha-2 country codes to block. Empty list = no geo restriction."
  default     = []
}

variable "cloud_armor_policy" {
  type        = any
  description = "Deprecated: use rate_limit_rpm + geo_restriction_countries instead. Kept for backward compat."
  default     = {}
}

# ---------------------------------------------------------------------------
# Cloud CDN
# ---------------------------------------------------------------------------

variable "enable_cdn" {
  type        = bool
  description = "Enable Cloud CDN on the backend service"
  default     = true
}

# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
