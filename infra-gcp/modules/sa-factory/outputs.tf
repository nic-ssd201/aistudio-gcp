output "email" {
  description = "Service account email — pass to Cloud Run / Cloud Run Jobs / etc. as `service_account`."
  value       = google_service_account.this.email
}

output "member" {
  description = "IAM member identifier ('serviceAccount:<email>'). Convenient for passing to downstream *_iam_member resources."
  value       = "serviceAccount:${google_service_account.this.email}"
}

output "name" {
  description = "Fully-qualified service account resource name (projects/.../serviceAccounts/...)."
  value       = google_service_account.this.name
}

output "unique_id" {
  description = "Numeric, immutable unique ID of the service account. Useful in audit-log filters."
  value       = google_service_account.this.unique_id
}

output "account_id" {
  description = "The account_id portion ('sa-<name>')."
  value       = google_service_account.this.account_id
}
