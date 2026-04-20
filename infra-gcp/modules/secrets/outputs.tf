output "secret_ids" {
  description = "Map of logical secret key to Secret Manager secret_id (short name, not full resource path)"
  value       = { for k, s in google_secret_manager_secret.secrets : k => s.secret_id }
}

output "secret_names" {
  description = "Map of logical secret key to full Secret Manager resource name (projects/PROJECT/secrets/NAME)"
  value       = { for k, s in google_secret_manager_secret.secrets : k => s.name }
}

output "secret_version_refs" {
  description = <<-EOT
    Map of logical secret key to { name, version_ref } for Cloud Run secret_key_ref injection.
    version_ref is the full resource path to the "latest" version alias:
      projects/PROJECT/secrets/NAME/versions/latest
    Usage in cloud-run-web/cloud-run-job:
      value_source {
        secret_key_ref {
          secret  = module.secrets.secret_version_refs["aistudio-nextauth-secret"].name
          version = "latest"
        }
      }
  EOT
  sensitive   = true
  value = {
    for k, s in google_secret_manager_secret.secrets : k => {
      name        = s.name
      version_ref = "${s.name}/versions/latest"
    }
  }
}

# Convenience alias — version_refs keyed by logical key, value = version_ref string.
# Wave C modules can use this directly in secret_key_ref.version.
output "version_refs" {
  description = "Map of logical secret key to full version-pinned ref string (for Cloud Run secret_key_ref)"
  sensitive   = true
  value       = { for k, s in google_secret_manager_secret.secrets : k => "${s.name}/versions/latest" }
}
