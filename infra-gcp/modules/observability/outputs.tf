output "dashboard_ids" {
  description = "Map of dashboard display name to resource name"
  value = {
    unified = google_monitoring_dashboard.unified.id
  }
}

output "alert_policy_ids" {
  description = "Map of alert policy display name to resource name"
  value = {
    cloud_run_error_rate = google_monitoring_alert_policy.cloud_run_error_rate.id
    alloydb_cpu          = google_monitoring_alert_policy.alloydb_cpu.id
    ferpa_tripwire       = google_monitoring_alert_policy.ferpa_tripwire.id
    vertex_quota         = google_monitoring_alert_policy.vertex_quota.id
    budget_warning       = google_monitoring_alert_policy.budget_warning.id
  }
}

output "slo_ids" {
  description = "Map of SLO display name to resource ID"
  value = {
    for k, v in google_monitoring_slo.this : k => v.id
  }
}

output "uptime_check_ids" {
  description = "Map of uptime check display name to check ID"
  value = {
    for k, v in google_monitoring_uptime_check_config.this : k => v.uptime_check_id
  }
}

output "notification_channel_ids" {
  description = "Map of channel display name to channel ID"
  value = {
    for k, v in google_monitoring_notification_channel.this : k => v.id
  }
}

output "audit_log_sink_name" {
  description = "Resource name of the general audit log sink"
  value       = google_logging_project_sink.audit_logs.id
}

output "ferpa_audit_sink_name" {
  description = "Resource name of the FERPA tripwire audit log sink"
  value       = google_logging_project_sink.ferpa_audit.id
}

output "ferpa_audit_bucket_name" {
  description = "Name of the FERPA audit GCS bucket (created or passed in)"
  value       = local.ferpa_audit_bucket_name
}

output "ferpa_tripwire_metric_name" {
  description = "Logging metric name for FERPA tripwire events (for use in vpc-sc or other alert policies)"
  value       = google_logging_metric.ferpa_tripwire.name
}

output "vpc_sc_violation_metric_name" {
  description = "Logging metric name for VPC-SC violations"
  value       = google_logging_metric.vpc_sc_violations.name
}
