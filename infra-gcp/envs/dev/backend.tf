terraform {
  backend "gcs" {
    bucket = "aistudio-tfstate-dev"
    prefix = "dev"
  }
}
