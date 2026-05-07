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
  description = "Primary GCP region (used for FERPA audit bucket location)"
  default     = "us-west1"
}

variable "slos" {
  type = list(object({
    display_name         = string
    service_id           = string
    goal                 = number
    type                 = optional(string, "availability") # availability | latency
    calendar_period      = optional(string, "DAY")
    distribution_filter  = optional(string, "")
    latency_threshold_ms = optional(number, 2000)
  }))
  description = "SLO definitions. Each entry creates a google_monitoring_slo."
  default     = []
}

variable "alert_channels" {
  type = list(object({
    display_name = string
    type         = string # pagerduty | webhook_tokenauth | webhook_basicauth
    labels       = optional(map(string), {})
    sensitive_labels = optional(object({
      auth_token  = optional(string, "")
      service_key = optional(string, "")
      password    = optional(string, "")
    }), {})
  }))
  description = "Alert notification channels. Must include pagerduty, webhook_tokenauth (Telegram), and webhook_basicauth (Google Chat) for full FERPA tripwire fan-out."
  default     = []
  sensitive   = true
}

variable "uptime_urls" {
  type = list(object({
    display_name = string
    host         = string
    path         = optional(string, "/api/health")
    port         = optional(number, 443)
    use_ssl      = optional(bool, true)
    validate_ssl = optional(bool, true)
  }))
  description = "URLs to monitor with Cloud Monitoring uptime checks."
  default     = []
}

variable "dashboards" {
  type        = list(string)
  description = "Paths to JSON dashboard definitions (unused if custom_dashboard_json is provided). For future multi-dashboard support."
  default     = []
}

variable "custom_dashboard_json" {
  type        = string
  description = "Custom dashboard JSON. If empty, the module ships a default unified dashboard."
  default     = ""
}

variable "audit_logs_bucket" {
  type        = string
  description = "GCS bucket name for general audit logs (from storage module output). Log sink will route cloudaudit logs here."
}

variable "ferpa_audit_bucket" {
  type        = string
  description = "GCS bucket name for FERPA audit logs (7-year retention, CMEK). If empty, this module creates aistudio-<env>-ferpa-audit."
  default     = ""
}

variable "ferpa_audit_kms_key" {
  type        = string
  description = "CMEK KMS key resource name for the FERPA audit bucket. Required if ferpa_audit_bucket is empty (i.e., this module creates the bucket)."
  default     = ""
}

variable "budget_alert_threshold" {
  type        = number
  description = "Monthly budget threshold in USD. dev=5000, staging=10000, prod=20000. Set 0 to disable budget alert."
  default     = 5000
}

variable "labels" {
  type        = map(string)
  description = "Resource labels (merged into module-defined labels)"
  default     = {}
}
