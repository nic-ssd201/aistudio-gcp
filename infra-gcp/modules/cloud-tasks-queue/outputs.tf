output "queue_id" {
  description = "Fully-qualified queue resource path (projects/.../locations/.../queues/...)"
  value       = google_cloud_tasks_queue.queue.id
}

output "queue_name" {
  description = "Queue short name"
  value       = google_cloud_tasks_queue.queue.name
}
