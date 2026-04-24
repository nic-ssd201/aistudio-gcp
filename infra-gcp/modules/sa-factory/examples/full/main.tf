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

# Prerequisite resources that the SA will bind to.
# We create these here rather than assume they exist so tests are hermetic.

resource "google_storage_bucket" "test" {
  name                        = "${var.name_prefix}-bucket"
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true

  labels = {
    environment = "dev"
    managed-by  = "terraform"
    test        = "true"
  }
}

resource "google_secret_manager_secret" "test" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-secret"

  replication {
    auto {}
  }

  labels = {
    environment = "dev"
    managed-by  = "terraform"
    test        = "true"
  }
}

# The module under test.
module "sa" {
  source = "../../"

  name        = var.name_prefix
  project_id  = var.project_id
  environment = "dev"
  description = "Terratest full example"

  storage_buckets = [
    { bucket = google_storage_bucket.test.name, role = "roles/storage.objectAdmin" },
  ]

  secrets = [
    { secret_id = google_secret_manager_secret.test.secret_id, role = "roles/secretmanager.secretAccessor" },
  ]

  vertex_ai_enabled = true
}
