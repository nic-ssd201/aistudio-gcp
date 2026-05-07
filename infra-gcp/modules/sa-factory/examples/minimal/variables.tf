variable "project_id" {
  description = "GCP project that will own the test service account."
  type        = string
}

variable "name_prefix" {
  description = "Workload name passed to sa-factory. Tests pass a randomized value."
  type        = string
}

variable "region" {
  description = "Region for the provider block. Not used by sa-factory directly, but required for the provider."
  type        = string
  default     = "us-central1"
}
