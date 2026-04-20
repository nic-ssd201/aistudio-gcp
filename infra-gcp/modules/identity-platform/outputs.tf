output "tenant_id" {
  description = "Identity Platform tenant ID (short form)"
  value       = google_identity_platform_tenant.this.name
}

output "tenant_name" {
  description = "Identity Platform tenant full resource name"
  value       = google_identity_platform_tenant.this.name
}

output "oidc_provider_names" {
  description = "Map of display_name → full OIDC provider resource name"
  value = {
    for k, v in google_identity_platform_tenant_oauth_idp_config.oidc :
    k => v.name
  }
}

output "oidc_issuer_url" {
  description = "Workspace OIDC issuer URL (authoritative from spec)"
  value       = "https://accounts.google.com"
}

output "oidc_audience" {
  description = "OIDC audience — project-number-scoped tenant audience for token validation"
  value       = "projects/${var.project_id}/tenants/${google_identity_platform_tenant.this.name}"
}
