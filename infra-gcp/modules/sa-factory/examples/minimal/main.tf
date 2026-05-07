terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Minimal invocation: just a service account with default observability roles.
module "sa" {
  source = "../../"

  name        = var.name_prefix
  project_id  = var.project_id
  environment = "dev"
  description = "Terratest minimal example"
}
