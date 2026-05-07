variable "access_policy_name" {
  type        = string
  description = "Organization-level VPC Service Controls access policy name (numeric, e.g., \"1234567890\"). Created out-of-band at org level — do not manage here."
}

variable "perimeter_name" {
  type        = string
  description = "Service perimeter name (e.g., aistudio_prod_perimeter — underscores only, no hyphens)"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev|staging|prod)"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "project_numbers" {
  type        = list(string)
  description = "GCP project numbers (NOT project IDs) to include in the perimeter. Use data.google_project.*.number at env level."
}

variable "restricted_services" {
  type        = list(string)
  description = "Services to restrict. Defaults to Vertex, AlloyDB, Secret Manager, Cloud Storage, Artifact Registry per spec §3.3."
  default = [
    "aiplatform.googleapis.com",
    "alloydb.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

variable "ingress_rules" {
  type = list(object({
    identity_type = optional(string, "ANY_IDENTITY")
    identities    = optional(list(string), [])
    access_level  = optional(string, "*")
    services      = optional(list(string), [])
  }))
  description = "Additional ingress policy rules (appended to built-in Console + WIF + IdP rules)."
  default     = []
}

variable "egress_rules" {
  type = list(object({
    identity_type = optional(string, "ANY_IDENTITY")
    identities    = optional(list(string), [])
    services      = optional(list(string), [])
  }))
  description = "Additional egress policy rules (appended to built-in identitytoolkit egress rule)."
  default     = []
}

variable "enforce_mode" {
  type        = bool
  description = "DANGER: Set true only after 7 days of clean dry-run with zero unexpected violations. Promotes perimeter from dry-run to enforced — violations become real access denials."
  default     = false
}

variable "labels" {
  type        = map(string)
  description = "Resource labels"
  default     = {}
}
