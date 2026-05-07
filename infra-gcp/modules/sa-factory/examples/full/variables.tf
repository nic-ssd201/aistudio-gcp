variable "project_id" {
  description = "GCP project for the test SA and its dependencies."
  type        = string
}

variable "name_prefix" {
  description = "Prefix used for SA name, bucket name, and secret id. Tests pass a randomized value."
  type        = string
}

variable "region" {
  description = "Region used for bucket location and provider default."
  type        = string
  default     = "us-central1"
}
