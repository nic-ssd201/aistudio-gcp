terraform {
  backend "gcs" {
    bucket = "aistudio-tfstate-prod"
    prefix = "prod"
  }
}
