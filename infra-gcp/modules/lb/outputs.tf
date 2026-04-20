output "load_balancer_ip" {
  description = "Global external static IP address — point your DNS A record here"
  value       = google_compute_global_address.lb.address
}

output "load_balancer_name" {
  description = "Backend service resource name"
  value       = google_compute_backend_service.web.name
}

output "load_balancer_url" {
  description = "Primary HTTPS URL (first domain in var.domains)"
  value       = length(local.effective_domains) > 0 ? "https://${local.effective_domains[0]}" : "https://${google_compute_global_address.lb.address}"
}

output "managed_cert_name" {
  description = "Certificate Manager certificate resource name"
  value       = google_certificate_manager_certificate.lb.name
}

output "armor_policy_name" {
  description = "Cloud Armor security policy resource name"
  value       = google_compute_security_policy.armor.name
}

# Retained for backward compat with Haiku scaffold outputs.tf stub names.
output "health_check_id" {
  description = "Not applicable for Serverless NEG backends (Cloud Run has built-in health checking)"
  value       = null
}

output "cloud_armor_policy_name" {
  description = "Alias for armor_policy_name"
  value       = google_compute_security_policy.armor.name
}
