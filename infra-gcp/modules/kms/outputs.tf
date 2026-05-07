output "keyring_id" {
  description = "KMS keyring resource ID"
  value       = google_kms_key_ring.main.id
}

output "keyring_name" {
  description = "KMS keyring resource name"
  value       = google_kms_key_ring.main.name
}

output "key_ids" {
  description = "Map of key names to fully-qualified key IDs (used as CMEK references)"
  value       = { for k, v in google_kms_crypto_key.keys : k => v.id }
}

output "key_names" {
  description = "Map of key names to resource names"
  value       = { for k, v in google_kms_crypto_key.keys : k => v.name }
}
