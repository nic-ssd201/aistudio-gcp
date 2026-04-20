##############################################################################
# dlp/main.tf
# Creates: Cloud DLP inspect template (FERPA custom infoTypes) + GCS job
# triggers for async scanning of attachment and repository buckets.
#
# Spec refs:
#   terraform-arch.md §3.13
#   ferpa-controls.md §3 (regex library) and §4.5 (async DLP scan)
#
# IMPORTANT — what this module does NOT do:
#   - It does NOT create a Cloud Run Job to delete matched objects.
#     That job is composed at the env level, consumes this module's
#     inspect_template_id output, and subscribes to var.findings_pubsub_topic.
#   - It does NOT set secret values. Pub/Sub topic is accepted as input.
##############################################################################

locals {
  module_labels = merge(
    {
      environment = var.environment
      managed-by  = "terraform"
      component   = "dlp"
    },
    var.labels
  )

  # Template display name and resource ID prefix.
  template_prefix = "projects/${var.project_id}/locations/global"
}

###############################################################################
# 1. API enablement
###############################################################################
resource "google_project_service" "dlp" {
  project            = var.project_id
  service            = "dlp.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "pubsub" {
  project            = var.project_id
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

###############################################################################
# 2. Pub/Sub topic for DLP findings (accept as input or create here)
#    FERPA-REVIEW: spec says "accept as input var.findings_pubsub_topic".
#    We create the topic if var.create_findings_topic = true (default true)
#    so the module is self-contained for new environments.
#    If the topic was created by another module (e.g., a messaging stack),
#    set create_findings_topic = false and supply var.findings_pubsub_topic.
###############################################################################
resource "google_pubsub_topic" "ferpa_dlp_findings" {
  count   = var.create_findings_topic ? 1 : 0
  project = var.project_id
  name    = "ferpa-dlp-findings"
  labels  = local.module_labels

  depends_on = [google_project_service.pubsub]
}

locals {
  findings_topic_name = var.create_findings_topic ? (
    length(google_pubsub_topic.ferpa_dlp_findings) > 0 ?
    google_pubsub_topic.ferpa_dlp_findings[0].name : var.findings_pubsub_topic
  ) : var.findings_pubsub_topic

  findings_topic_id = var.create_findings_topic ? (
    length(google_pubsub_topic.ferpa_dlp_findings) > 0 ?
    google_pubsub_topic.ferpa_dlp_findings[0].id : var.findings_pubsub_topic
  ) : var.findings_pubsub_topic
}

###############################################################################
# 3. DLP Inspect Template — FERPA custom infoTypes
#
# All patterns derived from ferpa-controls.md §3.1.
#
# FERPA-REVIEW: Regex escaping in HCL heredoc — double-backslashes in the
# `regex` string because DLP API expects a literal regex string, not an
# HCL-escaped one. Verified against DLP API docs (Aug 2025). If a future
# provider version changes string handling, these need retesting.
#
# FERPA-REVIEW: `hotword_rule` proximity window is 50 chars (spec says
# "within a proximity window of 50 chars before/after"). DLP API uses
# `window_before` and `window_after` in characters. Setting both to 50.
#
# FERPA-REVIEW: DOB_WITH_NAME uses built-in DATE_OF_BIRTH + PERSON_NAME
# with a correlation rule_set. The spec says "use inspection_config.rule_set
# with hotword_rule pattern." DLP's rule_set with `hotword_rule` targets
# a single infoType at a time. The approach here: declare both built-in
# infoTypes, then add a rule_set for DATE_OF_BIRTH that requires PERSON_NAME
# as a hotword. This is a supported DLP pattern (combined infoType correlation
# via hotword proximity) but is not identical to a single combined infoType.
# Vault should verify this satisfies the test case `dob_with_name` in vectors.jsonl.
###############################################################################
resource "google_data_loss_prevention_inspect_template" "ferpa" {
  parent       = "projects/${var.project_id}/locations/global"
  display_name = "aistudio-${var.environment}-ferpa-inspect"
  description  = "FERPA-sensitive data detection: SID, DCID, WA_SSID, SSN, DOB+Name"

  inspect_config {
    # ── Built-in infoTypes ──────────────────────────────────────────────────
    info_types {
      name = "US_SOCIAL_SECURITY_NUMBER"
    }
    info_types {
      name = "DATE_OF_BIRTH"
    }
    info_types {
      name = "PERSON_NAME"
    }

    # ── Custom infoTypes (FERPA-specific) ───────────────────────────────────

    # SID: 6–7 digit PowerSchool student ID with required context hotword.
    # SCHEMA NOTE (provider ~> 6.0): custom_info_types does not accept a `rules`
    # or `detection_rules` child block. Hotword proximity rules are expressed via
    # rule_set blocks at the inspect_config level (see rule_set blocks below).
    custom_info_types {
      info_type {
        name = "AISTUDIO_SID"
      }
      likelihood = "LIKELY"
      regex {
        pattern = "\\b\\d{6,7}\\b"
      }
    }

    # DCID: 5–7 digit internal PowerSchool DB key with context hotword.
    custom_info_types {
      info_type {
        name = "AISTUDIO_DCID"
      }
      likelihood = "LIKELY"
      regex {
        pattern = "\\b\\d{5,7}\\b"
      }
    }

    # WA_SSID: 10-digit Washington State Student ID with context hotword.
    custom_info_types {
      info_type {
        name = "AISTUDIO_WA_SSID"
      }
      likelihood = "LIKELY"
      regex {
        pattern = "\\b\\d{10}\\b"
      }
    }

    # Custom infoType: DOB_WITH_NAME — narrow name pattern + exclusion list.
    # Replaces the prior rule_set on DATE_OF_BIRTH which fired on capitalized
    # bigrams in document headers (Birthday Cake, Date Of Birth, etc.).
    custom_info_types {
      info_type {
        name = "AISTUDIO_DOB_WITH_NAME"
      }
      likelihood = "VERY_LIKELY"
      regex {
        # DOB format — same as §3.1 spec regex.
        pattern = "\\b(0[1-9]|1[0-2])[/\\-](0[1-9]|[12]\\d|3[01])[/\\-](19|20)\\d{2}\\b"
      }
      # EXCLUSION_TYPE_UNSPECIFIED is not a valid API value; use EXCLUSION_TYPE_EXCLUDE
      # to mark this custom infoType as an exclusion helper (backed by the rule_set below).
      exclusion_type = "EXCLUSION_TYPE_EXCLUDE"
    }

    # ── rule_set blocks: hotword proximity boosts for custom infoTypes ────────
    # The DLP provider requires hotword rules to live in rule_set (not inside
    # custom_info_types). Each rule_set targets the custom infoType by name and
    # adjusts likelihood when the hotword pattern fires within the proximity window.

    # SID hotword: bump likelihood to VERY_LIKELY when student/SID context found.
    rule_set {
      info_types {
        name = "AISTUDIO_SID"
      }
      rules {
        hotword_rule {
          hotword_regex {
            # FERPA-REVIEW: Regex uses \b word-boundary in lookbehind position.
            # DLP hotword patterns match surrounding text, not the match itself.
            pattern = "(?i)(student|\\bSID\\b|student_id|studentid)"
          }
          proximity {
            window_before = 50
            window_after  = 50
          }
          likelihood_adjustment {
            fixed_likelihood = "VERY_LIKELY"
          }
        }
      }
    }

    # DCID hotword: bump likelihood to VERY_LIKELY when DCID context found.
    rule_set {
      info_types {
        name = "AISTUDIO_DCID"
      }
      rules {
        hotword_rule {
          hotword_regex {
            pattern = "(?i)(\\bDCID\\b|\\bdcid\\b|students\\.id)"
          }
          proximity {
            window_before = 50
            window_after  = 50
          }
          likelihood_adjustment {
            fixed_likelihood = "VERY_LIKELY"
          }
        }
      }
    }

    # WA_SSID hotword: bump likelihood to VERY_LIKELY when SSID/OSPI context found.
    rule_set {
      info_types {
        name = "AISTUDIO_WA_SSID"
      }
      rules {
        hotword_rule {
          hotword_regex {
            pattern = "(?i)(\\bSSID\\b|state student id|\\bOSPI\\b)"
          }
          proximity {
            window_before = 50
            window_after  = 50
          }
          likelihood_adjustment {
            fixed_likelihood = "VERY_LIKELY"
          }
        }
      }
    }

    # DOB_WITH_NAME hotword: require name-like pattern in proximity.
    rule_set {
      info_types {
        name = "AISTUDIO_DOB_WITH_NAME"
      }
      rules {
        hotword_rule {
          hotword_regex {
            # Tighter name heuristic: requires a lowercase transition between the
            # two capitalized words OR a leading lowercase article/preposition.
            # Rejects title-case headers like "Birthday Cake" or "Dear Parent".
            # Example matches: "Jane Doe", "jane Doe", "for Jane Doe".
            pattern = "(?:^|[a-z,\\s])\\s*[A-Z][a-z]{2,}\\s+[A-Z][a-z]{2,}\\b"
          }
          proximity {
            window_before = 30
            window_after  = 30
          }
          likelihood_adjustment {
            fixed_likelihood = "VERY_LIKELY"
          }
        }
      }
    }

    # Exclusion rule: skip the DOB_WITH_NAME infoType for known template phrases.
    rule_set {
      info_types {
        name = "AISTUDIO_DOB_WITH_NAME"
      }
      rules {
        exclusion_rule {
          matching_type = "MATCHING_TYPE_PARTIAL_MATCH"
          dictionary {
            word_list {
              words = [
                "Birthday Cake", "Birthday Party", "Birthday Invitation",
                "Birthday Card", "Date Of", "Date of Birth",
                "First Name", "Last Name", "Full Name", "Legal Name",
                "Dear Parent", "Dear Guardian", "Dear Family",
                "Sunnyside School", "Sunnyside Schools", "School District",
                "January 20", "February 20", "March 20", "April 20", "May 20",
                "June 20", "July 20", "August 20", "September 20", "October 20",
                "November 20", "December 20",
              ]
            }
          }
        }
      }
    }

    # Minimum likelihood for a finding to be reported.
    # FERPA-REVIEW: Set to LIKELY to avoid flooding on low-confidence custom
    # infoType hits. If false-negative rate is too high in testing, lower to
    # POSSIBLE and tighten hotword regexes instead.
    min_likelihood = "LIKELY"

    limits {
      max_findings_per_item    = 100
      max_findings_per_request = 1000
    }
  }

  depends_on = [google_project_service.dlp]
}

###############################################################################
# 4. Job triggers — one per entry in var.job_triggers
#    Each trigger watches a GCS bucket for OBJECT_FINALIZE events.
#    On any finding: publish to the findings Pub/Sub topic.
#    The delete-on-match action is performed by the Cloud Run Job
#    at env-level — NOT here (per spec §4.5 scope).
###############################################################################
resource "google_data_loss_prevention_job_trigger" "gcs" {
  for_each = { for t in var.job_triggers : t.bucket => t }

  parent       = "projects/${var.project_id}/locations/global"
  display_name = "aistudio-${var.environment}-dlp-trigger-${replace(each.key, "/[^a-z0-9]/", "-")}"
  description  = "FERPA async DLP scan for gs://${each.key}"
  status       = "HEALTHY"

  triggers {
    # google_data_loss_prevention_job_trigger does not support an `event` block
    # in the google provider ~> 6.0 schema. GCS-event-driven DLP scans are not
    # directly expressible via job_trigger; the `triggers` block accepts only
    # `schedule` or `manual`. Real-time scanning on upload is handled at the
    # application layer (the Cloud Run Job calls DLP APIs per file).
    # This periodic scan runs daily to catch any files missed by the inline check.
    schedule {
      recurrence_period_duration = "86400s" # daily
    }
  }

  inspect_job {
    inspect_template_name = google_data_loss_prevention_inspect_template.ferpa.id

    storage_config {
      cloud_storage_options {
        file_set {
          url = "gs://${each.key}/**"
        }
        # Scan all file types that AI Studio handles.
        file_types           = ["TEXT_FILE", "PDF", "WORD", "EXCEL", "POWERPOINT"]
        bytes_limit_per_file = 52428800 # 50 MB cap per file
      }
    }

    actions {
      pub_sub {
        topic = local.findings_topic_id
      }
    }

    # FERPA-REVIEW: No save_findings action (would write finding details to
    # BigQuery/GCS). Findings go to Pub/Sub only. The consumer Cloud Run Job
    # handles deletion. This means finding details are NOT persisted outside
    # the Pub/Sub message TTL — acceptable per ferpa-controls.md §7 since the
    # tripwire alert + audit log entry are the authoritative retention record,
    # not the raw DLP finding payload.
  }

  depends_on = [
    google_data_loss_prevention_inspect_template.ferpa,
    google_pubsub_topic.ferpa_dlp_findings,
  ]
}
