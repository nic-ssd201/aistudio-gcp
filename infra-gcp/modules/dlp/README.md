# dlp module

**Purpose:** Cloud DLP inspect template with FERPA-specific custom infoTypes (SID, DCID, WA_SSID, SSN, DOB+Name) and GCS job triggers for async scanning of attachment and repository-document buckets. FERPA Layer 4.5.

## Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string | yes | GCP project ID |
| `environment` | string | yes | dev/staging/prod |
| `job_triggers` | list(object) | no | Buckets to scan: `[{ bucket = "bucket-name" }]`. Use storage module output. |
| `findings_pubsub_topic` | string | no | Pub/Sub topic ID for findings. Required if `create_findings_topic = false`. |
| `create_findings_topic` | bool | no | Create `ferpa-dlp-findings` topic here (default: true). |
| `labels` | map(string) | no | Resource labels |

## Outputs

| Name | Description |
|------|-------------|
| `inspect_template_names` | Map `{ ferpa = "<full-resource-id>" }` |
| `inspect_template_id` | FERPA template full resource name (pass to Cloud Run Job at env level) |
| `job_trigger_names` | Map of bucket name → job trigger resource ID |
| `findings_pubsub_topic` | Pub/Sub topic name where findings are published |

## FERPA infoTypes

| Custom infoType | Pattern | Context (hotword) |
|---|---|---|
| `AISTUDIO_SID` | `\b\d{6,7}\b` | `student`, `SID`, `student_id`, `studentid` within ±50 chars |
| `AISTUDIO_DCID` | `\b\d{5,7}\b` | `DCID`, `dcid`, `students.id` within ±50 chars |
| `AISTUDIO_WA_SSID` | `\b\d{10}\b` | `SSID`, `state student id`, `OSPI` within ±50 chars |
| `US_SOCIAL_SECURITY_NUMBER` | built-in | — |
| `DATE_OF_BIRTH` + `PERSON_NAME` | built-in + rule_set | DOB with name-like token within ±50 chars |

## What this module does NOT do

- Does NOT create the Cloud Run Job that deletes matched objects. That job is composed at env level, consuming `inspect_template_id` from this module's output.
- Does NOT write DLP findings to BigQuery — findings go to Pub/Sub only.

## Gotchas

- `job_triggers` take bucket names WITHOUT `gs://` prefix.
- DLP `google_data_loss_prevention_job_trigger` event-based triggers on GCS OBJECT_FINALIZE require Eventarc configuration at the bucket level — confirm the bucket has the DLP service account access.
- The `DOB_WITH_NAME` correlation uses a regex proxy for PERSON_NAME in the hotword rule (DLP hotword_rule accepts regex, not infoType refs). See FERPA-REVIEW comment in main.tf.

See spec §3.13 and ferpa-controls.md §3, §4.5.
