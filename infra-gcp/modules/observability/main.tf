##############################################################################
# observability/main.tf
# Creates: alert policies, SLO resources, uptime checks, log sinks,
#          notification channels, dashboards.
#
# Spec refs:
#   terraform-arch.md §3.14
#   ferpa-controls.md §6 (alert fanout topology) and §7 (audit retention)
##############################################################################

locals {
  module_labels = merge(
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "observability"
    },
    var.labels
  )

  # Build a lookup map from channel type → channel ID for alert policy wiring.
  # Channels are created below; this local resolves after creation.
  channel_id_by_type = {
    for ch in google_monitoring_notification_channel.this :
    ch.type => ch.id
  }

  # Convenience: common alert channel sets per FERPA spec §6.
  # FERPA-REVIEW: All 3 channels (pagerduty + telegram + google_chat) must fire
  # on ferpa_tripwire events. This is enforced by the ferpa_tripwire alert policy
  # below referencing all created channel IDs. If any channel type is missing
  # from var.alert_channels, the alert fires on available channels only — NOT a
  # silent failure, but Vault should verify channel completeness before prod go-live.
  all_channel_ids = [for ch in google_monitoring_notification_channel.this : ch.id]
}

###############################################################################
# 1. APIs
###############################################################################
resource "google_project_service" "monitoring" {
  project            = var.project_id
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "logging" {
  project            = var.project_id
  service            = "logging.googleapis.com"
  disable_on_destroy = false
}

###############################################################################
# 2. Notification channels
#    Supports: pagerduty, webhook_tokenauth (Telegram), webhook_basicauth (Google Chat)
#    Channel configs passed via var.alert_channels (list of objects).
###############################################################################
resource "google_monitoring_notification_channel" "this" {
  for_each = { for ch in var.alert_channels : ch.display_name => ch }

  project      = var.project_id
  display_name = each.value.display_name
  type         = each.value.type

  # Labels differ by type:
  # pagerduty:        { service_key: ... }
  # webhook_tokenauth: { url: ... }
  # webhook_basicauth: { url: ..., username: ..., password: ... } (sensitive)
  labels = lookup(each.value, "labels", {})

  # Sensitive label values (auth tokens) — marked sensitive in variables.tf.
  sensitive_labels {
    auth_token  = lookup(lookup(each.value, "sensitive_labels", {}), "auth_token", "")
    service_key = lookup(lookup(each.value, "sensitive_labels", {}), "service_key", "")
    password    = lookup(lookup(each.value, "sensitive_labels", {}), "password", "")
  }

  user_labels = local.module_labels

  depends_on = [google_project_service.monitoring]
}

###############################################################################
# 3. Log-based metric: FERPA tripwire fires
#    Filter on severity=CRITICAL AND jsonPayload.ferpa_tripwire=true.
#    Referenced by the FERPA alert policy below.
###############################################################################
resource "google_logging_metric" "ferpa_tripwire" {
  project = var.project_id
  name    = "aistudio_ferpa_tripwire_count"
  filter  = "severity=CRITICAL AND jsonPayload.ferpa_tripwire=true"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "FERPA Tripwire Events"
  }

  depends_on = [google_project_service.logging]
}

###############################################################################
# 4. Log-based metric: VPC-SC violations (referenced by vpc-sc module too)
###############################################################################
resource "google_logging_metric" "vpc_sc_violations" {
  project = var.project_id
  name    = "aistudio_vpc_sc_violations"
  filter  = "protoPayload.metadata.vpcServiceControlsUniqueId!=\"\""

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "VPC-SC Violations"
  }

  depends_on = [google_project_service.logging]
}

###############################################################################
# 5. Default alert policies
#    FERPA-REVIEW: FERPA tripwire alert uses all_channel_ids to fan out to
#    every configured channel (PagerDuty + Telegram + Google Chat).
#    Other alerts use a subset. If var.alert_channels doesn't include all 3
#    types at prod, this won't error — but Vault must verify completeness.
###############################################################################

# 5a. Cloud Run error rate > 5% for 5 min
resource "google_monitoring_alert_policy" "cloud_run_error_rate" {
  project      = var.project_id
  display_name = "aistudio-${var.environment}-cloud-run-error-rate"
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "Cloud Run request error rate > 5%"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_FRACTION_TRUE"
        group_by_fields      = ["resource.labels.service_name"]
      }
    }
  }

  notification_channels = local.all_channel_ids

  documentation {
    content   = "Cloud Run error rate exceeded 5% for 5 minutes. Check Cloud Run logs for ${var.environment}."
    mime_type = "text/markdown"
  }

  user_labels = local.module_labels
}

# 5b. AlloyDB CPU > 80% for 10 min
resource "google_monitoring_alert_policy" "alloydb_cpu" {
  project      = var.project_id
  display_name = "aistudio-${var.environment}-alloydb-cpu"
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "AlloyDB CPU utilization > 80%"
    condition_threshold {
      filter          = "resource.type=\"alloydb.googleapis.com/Instance\" AND metric.type=\"alloydb.googleapis.com/instance/cpu/utilization\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.80
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  # Telegram only (advance warning, not P1)
  notification_channels = [
    for ch in google_monitoring_notification_channel.this :
    ch.id if ch.type == "webhook_tokenauth"
  ]

  documentation {
    content   = "AlloyDB CPU > 80% for 10 minutes in ${var.environment}. Consider scaling up or investigating query load."
    mime_type = "text/markdown"
  }

  user_labels = local.module_labels
}

# 5c. FERPA tripwire fired — P1: all 3 channels (ferpa-controls.md §6)
resource "google_monitoring_alert_policy" "ferpa_tripwire" {
  project      = var.project_id
  display_name = "aistudio-${var.environment}-ferpa-tripwire-CRITICAL"
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "FERPA tripwire event detected"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ferpa_tripwire.name}\" AND resource.type=\"global\""
      duration        = "0s" # Alert immediately on any tripwire event
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  # FERPA-REVIEW: All channels — PagerDuty + Telegram + Google Chat.
  # Per ferpa-controls.md §6, this is non-negotiable. If any channel is
  # absent from var.alert_channels at go-live, Vault must block promotion to prod.
  notification_channels = local.all_channel_ids

  documentation {
    content   = "## FERPA TRIPWIRE FIRED\n\nA FERPA-sensitive data detection event occurred in **${var.environment}**.\n\nImmediate action required:\n1. Review Cloud Logging for `severity=CRITICAL AND jsonPayload.ferpa_tripwire=true`\n2. Identify the request_id and agent from the log payload\n3. Confirm DLP async scan is running on the affected bucket\n4. Escalate to district records officer if student records are confirmed\n\n**Do not share matched text in communications.**"
    mime_type = "text/markdown"
  }

  user_labels = merge(local.module_labels, { severity = "critical", ferpa = "true" })
}

# 5d. Vertex AI quota > 80%
resource "google_monitoring_alert_policy" "vertex_quota" {
  project      = var.project_id
  display_name = "aistudio-${var.environment}-vertex-quota"
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "Vertex AI quota utilization > 80%"
    condition_threshold {
      filter          = "resource.type=\"aiplatform.googleapis.com/Location\" AND metric.type=\"aiplatform.googleapis.com/quota/prediction_requests/usage\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.80
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [
    for ch in google_monitoring_notification_channel.this :
    ch.id if ch.type == "webhook_tokenauth"
  ]

  documentation {
    content   = "Vertex AI quota utilization > 80% in ${var.environment}. File a quota increase request if sustained."
    mime_type = "text/markdown"
  }

  user_labels = local.module_labels
}

# 5e. Budget alert handled via Cloud Billing Budget (google_billing_budget) —
#     FERPA-REVIEW: google_billing_budget requires billing account access which
#     is at org level, not project level. This policy is a PLACEHOLDER that
#     creates a log-based alert on cost estimation labels if available.
#     True budget alerts should be wired via Cloud Billing API with org-level
#     Terraform runner permissions. Opus should confirm if billing-scope TF
#     is in Wave A bootstrap or here.
#
# Thresholds per spec: dev=$5k, staging=$10k, prod=$20k (var.budget_alert_threshold).
resource "google_monitoring_alert_policy" "budget_warning" {
  project      = var.project_id
  display_name = "aistudio-${var.environment}-budget-warning"
  combiner     = "OR"
  enabled      = var.budget_alert_threshold > 0

  conditions {
    display_name = "Project spend approaching budget (log-based proxy)"
    condition_threshold {
      # This filter is a best-effort log-based proxy.
      # True budget alerts require google_billing_budget resource — see FERPA-REVIEW note above.
      filter          = "resource.type=\"global\" AND logName=\"projects/${var.project_id}/logs/cloudaudit.googleapis.com%2Factivity\" AND protoPayload.methodName=\"BudgetAlert\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = [
    for ch in google_monitoring_notification_channel.this :
    ch.id if ch.type == "webhook_tokenauth"
  ]

  documentation {
    content   = "Budget alert for ${var.environment} (threshold: $${var.budget_alert_threshold}/month). Review Cloud Billing for actual spend."
    mime_type = "text/markdown"
  }

  user_labels = local.module_labels
}

###############################################################################
# 6. SLOs — one per entry in var.slos
###############################################################################
resource "google_monitoring_slo" "this" {
  for_each = { for s in var.slos : s.display_name => s }

  project         = var.project_id
  service         = each.value.service_id
  slo_id          = replace(lower(each.key), "/[^a-z0-9]/", "-")
  display_name    = each.key
  goal            = each.value.goal
  calendar_period = lookup(each.value, "calendar_period", "DAY")

  dynamic "windows_based_sli" {
    for_each = lookup(each.value, "type", "availability") == "availability" ? [1] : []
    content {
      window_period = "3600s"
      good_total_ratio_threshold {
        threshold = each.value.goal
        performance {
          distribution_cut {
            distribution_filter = lookup(each.value, "distribution_filter", "metric.type=\"run.googleapis.com/request_latencies\"")
            range {
              max = lookup(each.value, "latency_threshold_ms", 2000)
            }
          }
        }
      }
    }
  }

  dynamic "request_based_sli" {
    for_each = lookup(each.value, "type", "availability") == "latency" ? [1] : []
    content {
      distribution_cut {
        distribution_filter = lookup(each.value, "distribution_filter", "metric.type=\"run.googleapis.com/request_latencies\"")
        range {
          max = lookup(each.value, "latency_threshold_ms", 2000)
        }
      }
    }
  }

  depends_on = [google_project_service.monitoring]
}

###############################################################################
# 7. Uptime checks
###############################################################################
resource "google_monitoring_uptime_check_config" "this" {
  for_each = { for u in var.uptime_urls : u.display_name => u }

  project      = var.project_id
  display_name = each.value.display_name
  timeout      = "10s"
  period       = "60s"

  http_check {
    path           = lookup(each.value, "path", "/api/health")
    port           = lookup(each.value, "port", 443)
    use_ssl        = lookup(each.value, "use_ssl", true)
    validate_ssl   = lookup(each.value, "validate_ssl", true)
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value.host
    }
  }

  depends_on = [google_project_service.monitoring]
}

###############################################################################
# 8. Log sinks
###############################################################################

# 8a. Audit logs → audit-logs GCS bucket (general)
resource "google_logging_project_sink" "audit_logs" {
  project                = var.project_id
  name                   = "aistudio-${var.environment}-audit-logs-sink"
  destination            = "storage.googleapis.com/${var.audit_logs_bucket}"
  filter                 = "logName:\"cloudaudit.googleapis.com\""
  unique_writer_identity = true
  description            = "All audit logs → audit-logs GCS bucket"
}

# Grant the sink's writer SA write access to the audit logs bucket.
resource "google_storage_bucket_iam_member" "audit_logs_sink_writer" {
  bucket = var.audit_logs_bucket
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.audit_logs.writer_identity
}

# 8b. FERPA tripwire logs → dedicated ferpa-audit bucket (7-year retention, CMEK)
#     FERPA-REVIEW: ferpa-controls.md §7 requires a SEPARATE log bucket for
#     tripwire events with 7-year retention and CMEK. This sink routes only
#     jsonPayload.ferpa_tripwire=true events. The bucket must exist before apply —
#     it's created in this module (see below) or supplied via var.ferpa_audit_bucket.
resource "google_logging_project_sink" "ferpa_audit" {
  project                = var.project_id
  name                   = "aistudio-${var.environment}-ferpa-audit-sink"
  destination            = "storage.googleapis.com/${local.ferpa_audit_bucket_name}"
  filter                 = "jsonPayload.ferpa_tripwire=true"
  unique_writer_identity = true
  description            = "FERPA tripwire events → ferpa-audit bucket (7-year retention)"
}

resource "google_storage_bucket_iam_member" "ferpa_audit_sink_writer" {
  bucket = local.ferpa_audit_bucket_name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.ferpa_audit.writer_identity
}

# 8c. FERPA audit GCS bucket — 7-year retention, CMEK.
#     Created here if var.ferpa_audit_bucket is empty.
#     FERPA-REVIEW: Bucket location defaults to us-west1 (same region as other
#     resources). Washington state data residency requirements don't prescribe
#     a specific region for audit logs, but keeping data in US-WEST is consistent
#     with the rest of the deployment. District records officer should confirm.
resource "google_storage_bucket" "ferpa_audit" {
  count    = var.ferpa_audit_bucket == "" ? 1 : 0
  project  = var.project_id
  # Naming: {name_prefix}-{env}-ferpa-audit — name_prefix MUST be org-namespaced
  # by the caller (e.g. "ssd201-aistudio"); GCS bucket names are global, see
  # var.name_prefix docstring + the same pattern in modules/storage.
  name     = "${var.name_prefix}-${var.environment}-ferpa-audit"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # 7-year retention lock (ferpa-controls.md §7).
  retention_policy {
    retention_period = 220752000 # 7 years in seconds (7 * 365.25 * 24 * 3600)
    is_locked        = false     # FERPA-REVIEW: Set is_locked=true only after confirming
    # retention period with district records officer.
    # Locking is irreversible.
  }

  # CMEK
  encryption {
    default_kms_key_name = var.ferpa_audit_kms_key
  }

  labels = merge(local.module_labels, { data-class = "ferpa-audit" })
}

locals {
  ferpa_audit_bucket_name = var.ferpa_audit_bucket != "" ? var.ferpa_audit_bucket : (
    length(google_storage_bucket.ferpa_audit) > 0 ?
    google_storage_bucket.ferpa_audit[0].name : ""
  )
}

###############################################################################
# 9. Unified monitoring dashboard
#    Sections: Cloud Run, AlloyDB, Vertex AI, FERPA tripwire count, budget burn.
#    FERPA-REVIEW: Dashboard JSON is inlined here as a minimal default.
#    Callers can override via var.custom_dashboard_json.
###############################################################################
resource "google_monitoring_dashboard" "unified" {
  project = var.project_id
  dashboard_json = var.custom_dashboard_json != "" ? var.custom_dashboard_json : jsonencode({
    displayName = "AI Studio — ${title(var.environment)} Unified"
    mosaicLayout = {
      tiles = [
        {
          width  = 6
          height = 4
          widget = {
            title = "Cloud Run — Request Latency (p99)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_latencies\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_PERCENTILE_99"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width  = 6
          height = 4
          xPos   = 6
          widget = {
            title = "Cloud Run — 5xx Error Rate"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_RATE"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width  = 6
          height = 4
          yPos   = 4
          widget = {
            title = "AlloyDB — CPU Utilization"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"alloydb.googleapis.com/Instance\" AND metric.type=\"alloydb.googleapis.com/instance/cpu/utilization\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width  = 6
          height = 4
          xPos   = 6
          yPos   = 4
          widget = {
            title = "AlloyDB — Active Connections"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"alloydb.googleapis.com/Instance\" AND metric.type=\"alloydb.googleapis.com/instance/postgresql/num_backends\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width  = 6
          height = 4
          yPos   = 8
          widget = {
            title = "FERPA Tripwire Events (last 24h)"
            scorecard = {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/aistudio_ferpa_tripwire_count\""
                  aggregation = {
                    alignmentPeriod  = "86400s"
                    perSeriesAligner = "ALIGN_SUM"
                  }
                }
              }
              thresholds = [{
                value = 1
                color = "RED"
              }]
            }
          }
        },
        {
          width  = 6
          height = 4
          xPos   = 6
          yPos   = 8
          widget = {
            title = "VPC-SC Violations (last 24h)"
            scorecard = {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/aistudio_vpc_sc_violations\""
                  aggregation = {
                    alignmentPeriod  = "86400s"
                    perSeriesAligner = "ALIGN_SUM"
                  }
                }
              }
              thresholds = [{
                value = 1
                color = "YELLOW"
              }]
            }
          }
        }
      ]
    }
  })

  depends_on = [
    google_project_service.monitoring,
    google_logging_metric.ferpa_tripwire,
    google_logging_metric.vpc_sc_violations,
  ]
}
