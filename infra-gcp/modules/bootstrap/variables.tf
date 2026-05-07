variable "host_project_id" {
  type        = string
  description = "Pre-created aistudio-shared project ID. Must exist before first apply — see PRE-CREATION REQUIREMENT in main.tf."
}

variable "org_id" {
  type        = string
  description = "GCP organization ID (used for the org-level audit log sink)"
}

variable "billing_account" {
  description = "Billing account ID (format: 'XXXXXX-XXXXXX-XXXXXX'). Required for google_billing_budget resources."
  type        = string
}

variable "budgets" {
  description = "Billing budgets keyed by display name. One per env project or for the billing account as a whole."
  type = map(object({
    amount_usd             = number
    project_ids            = optional(list(string), []) # scope budget to specific projects; empty = whole billing account
    threshold_percents     = optional(list(number), [0.5, 0.8, 1.0])
    notification_channels  = optional(list(string), []) # CM notification channel IDs
    pubsub_topic           = optional(string, null)     # optional pubsub firing
    credit_types_treatment = optional(string, "INCLUDE_ALL_CREDITS")
  }))
  default = {}

  validation {
    condition = alltrue([for b in values(var.budgets) :
      alltrue([for t in b.threshold_percents : t > 0 && t <= 2.0])
    ])
    error_message = "threshold_percents must all be > 0 and <= 2.0 (e.g., 0.5 = 50%, 1.0 = 100%, 1.2 = 120% for forecast alerts)."
  }
}

variable "state_bucket_name" {
  type        = string
  description = "GCS bucket name for Terraform state (must be globally unique)"
}

variable "state_bucket_location" {
  type        = string
  description = "GCS bucket location for state"
  default     = "us-west1"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository for WIF subject claim (e.g., psd401/aistudio)"
}

variable "openclaw_local_issuer" {
  type        = string
  description = "OIDC issuer URL for OpenClaw local runtime"
  default     = "http://localhost:18789"
}

variable "breakglass_email" {
  type        = string
  description = "Email address for the breakglass notification channel. Receives budget alerts on day 1, before observability channels exist."

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.breakglass_email))
    error_message = "breakglass_email must be a valid email address (e.g. it-breakglass@example.org)."
  }
}

variable "labels" {
  type        = map(string)
  description = "Resource labels"
  default     = {}
}
