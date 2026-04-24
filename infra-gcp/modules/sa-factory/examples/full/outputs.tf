output "email" {
  value = module.sa.email
}

output "member" {
  value = module.sa.member
}

output "account_id" {
  value = module.sa.account_id
}

output "bucket_name" {
  value = google_storage_bucket.test.name
}

output "secret_id" {
  value = google_secret_manager_secret.test.secret_id
}

output "project_id" {
  value = var.project_id
}
