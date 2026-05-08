output "cluster_uri" {
  description = "AlloyDB cluster resource URI"
  value       = google_alloydb_cluster.main.name
}

output "primary_instance_uri" {
  description = "Primary AlloyDB instance resource URI"
  value       = google_alloydb_instance.primary.name
}

output "read_pool_instance_uri" {
  description = "Read pool instance URI (empty string when read pool is disabled)"
  value       = var.enable_read_pool ? google_alloydb_instance.read_pool[0].name : ""
}

output "primary_private_ip" {
  description = "Private IP address of the primary AlloyDB instance (within PSA range)"
  value       = google_alloydb_instance.primary.ip_address
}

# No `connection_string` output: a template with literal "PASSWORD"/"DB_NAME"
# placeholders is a footgun (consumers wired it straight into Cloud Run as
# DATABASE_URL, which then short-circuits the credential-aware fallback in
# lib/db/drizzle-client.ts). Consumers should compose a connection from
# `primary_private_ip` + a Secret Manager reference for the password +
# DB_USER/DB_NAME literals — see envs/*/main.tf for the canonical wiring.
