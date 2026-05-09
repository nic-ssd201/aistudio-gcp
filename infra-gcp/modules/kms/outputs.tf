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

# Asymmetric signing keys — same shape as `key_ids` but for signing keys only.
# Note: callers typically need the cryptoKeyVersion path (the actual sign target),
# which they construct as `${signing_key_ids[name]}/cryptoKeyVersions/<N>`. KMS does
# NOT auto-manage the version for asymmetric keys (no auto-rotation); the consumer
# pins the version explicitly and bumps it manually after creating a new version
# via gcloud or the API.
output "signing_key_ids" {
  description = "Map of signing-key names to fully-qualified cryptoKey IDs"
  value       = { for k, v in google_kms_crypto_key.signing_keys : k => v.id }
}
