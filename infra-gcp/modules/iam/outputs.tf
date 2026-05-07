output "service_account_emails" {
  description = "Map of service account names to email addresses"
  value       = { for k, v in google_service_account.platform : k => v.email }
}

output "service_account_names" {
  description = "Map of service account names to fully-qualified resource names"
  value       = { for k, v in google_service_account.platform : k => v.name }
}

output "custom_roles" {
  description = "Map of custom role names to resource names (empty until custom roles are added)"
  value       = {}
}
