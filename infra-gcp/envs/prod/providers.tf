# user_project_override routes quota checks through the env project rather than
# the calling project — required when APIs are enabled on env_project_id.
provider "google" {
  project               = var.env_project_id
  region                = var.region
  user_project_override = true
}

provider "google-beta" {
  project               = var.env_project_id
  region                = var.region
  user_project_override = true
}
