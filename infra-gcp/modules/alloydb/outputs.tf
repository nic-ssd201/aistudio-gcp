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

output "connection_string" {
  description = "PostgreSQL connection string template — substitute DB_NAME and credentials at runtime"
  # sslmode=require is non-negotiable; AlloyDB enforces TLS and AI Studio's drizzle-client
  # auto-adds it, but this template makes the requirement explicit for Cloud Run env injection.
  value     = "postgresql://postgres:PASSWORD@${google_alloydb_instance.primary.ip_address}:5432/DB_NAME?sslmode=require"
  sensitive = true
}
