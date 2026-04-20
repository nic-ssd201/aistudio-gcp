# Bootstrap runs in the context of the shared project.
# user_project_override routes quota checks through host_project_id so that
# Monitoring API calls (for the notification channel) are billed correctly.
provider "google" {
  project               = var.host_project_id
  region                = var.region
  user_project_override = true
}

provider "google-beta" {
  project               = var.host_project_id
  region                = var.region
  user_project_override = true
}
