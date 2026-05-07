output "bucket_names" {
  description = "Map of logical bucket key to actual GCS bucket name (iterable by Wave C/D modules)"
  value       = { for k, b in google_storage_bucket.buckets : k => b.name }
}

output "bucket_urls" {
  description = "Map of logical bucket key to gs:// URL"
  value       = { for k, b in google_storage_bucket.buckets : k => b.url }
}

output "buckets" {
  description = "Map of logical bucket key to { name, url, self_link } — for Wave C/D consumption"
  value = {
    for k, b in google_storage_bucket.buckets : k => {
      name      = b.name
      url       = b.url
      self_link = b.self_link
    }
  }
}
