terraform {
  backend "gcs" {
    bucket = "aistudio-tfstate-staging"
    prefix = "staging"
  }
}
