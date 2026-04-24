output "inspect_template_names" {
  description = "Map of inspect template key to full resource name (pass to Cloud Run Job at env level)"
  value = {
    ferpa = google_data_loss_prevention_inspect_template.ferpa.id
  }
}

output "inspect_template_id" {
  description = "FERPA inspect template full resource name (convenience alias for the single template)"
  value       = google_data_loss_prevention_inspect_template.ferpa.id
}

output "job_trigger_names" {
  description = "Map of bucket name to DLP job trigger resource name"
  value = {
    for k, v in google_data_loss_prevention_job_trigger.gcs : k => v.id
  }
}

output "findings_pubsub_topic" {
  description = "Pub/Sub topic name where DLP findings are published"
  value       = local.findings_topic_id
}
