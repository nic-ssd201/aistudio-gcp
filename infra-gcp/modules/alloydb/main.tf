# AlloyDB module — provisions cluster, primary instance, and optional read pool.
# Consumes network module outputs (vpc_self_link, psa_range) and kms module output (kms_key).
# AlloyDB is the GCP replacement for Aurora Serverless v2 used by AI Studio on AWS.
#
# FERPA note (§4.6): AlloyDB supports standard PostgreSQL row-level security.
# The `data_class` column + RLS policies documented in ferpa-controls.md §4.6 are applied
# by Drizzle migrations (not Terraform) after the cluster is provisioned. No AlloyDB
# cluster-level flag is needed — RLS is a standard Postgres DDL feature and works on AlloyDB
# without configuration. This module ensures the cluster is otherwise unconstrained so
# `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` succeeds during migrations.

locals {
  cluster_name = var.cluster_name != "" ? var.cluster_name : "aistudio-${var.environment}"

  # Backup retention varies by environment — 7 days in dev saves cost, 30 days in prod/staging
  # meets district records requirements for operational data (FERPA-red data never reaches AlloyDB
  # directly, but operational metadata backup retention is still a district policy concern).
  backup_retention_days = var.environment == "dev" ? 7 : 30

  base_labels = {
    environment = var.environment
    managed-by  = "terraform"
    component   = "alloydb"
  }
  labels = merge(local.base_labels, var.labels)
}

# Fetch the initial password from Secret Manager so we never put plaintext in state.
# The secret is pre-populated by Nic/CI before first apply.
#
# `project` arg deliberately omitted — the Google provider extracts it from the
# secret resource path. Passing it explicitly causes a string-vs-number mismatch:
# var.project_id is the project ID ("ssd201-aistudio-dev"), but the secret name
# Google returns embeds the project NUMBER ("projects/627392752189/secrets/..."),
# and the provider validates them as if they were the same format.
#
# Caller may pass either the version_refs-style suffixed string
# ("projects/N/secrets/M/versions/latest") or the secret_version_refs[...].name
# clean path ("projects/N/secrets/M"); the provider tolerates both as long as
# `version` is set explicitly.
data "google_secret_manager_secret_version" "initial_password" {
  secret  = var.initial_user_password_secret
  version = "latest"
}

# AlloyDB cluster — VPC-peered via PSA, CMEK-encrypted.
resource "google_alloydb_cluster" "main" {
  project    = var.project_id
  cluster_id = local.cluster_name
  location   = var.region

  # Attach to VPC via Private Services Access — the PSA range is provisioned by the network module.
  # allocated_ip_range pins AlloyDB to the specific PSA range created by the network module,
  # ensuring IP allocation doesn't drift to a different reserved range if multiple exist.
  #
  # AlloyDB rejects the compute self_link URL format
  # ("https://www.googleapis.com/compute/v1/projects/X/global/networks/Y") and
  # requires the short relative path ("projects/X/global/networks/Y"). We strip
  # the URL prefix via regex rather than passing the network name + project
  # separately so this stays a one-line caller contract change.
  network_config {
    network            = replace(var.vpc_self_link, "https://www.googleapis.com/compute/v1/", "")
    allocated_ip_range = var.psa_range
  }

  # CMEK: all data at rest encrypted with the environment's alloydb key from the kms module.
  encryption_config {
    kms_key_name = var.kms_key
  }

  initial_user {
    user     = "postgres"
    password = data.google_secret_manager_secret_version.initial_password.secret_data
  }

  # Daily automated backups with environment-appropriate retention.
  automated_backup_policy {
    enabled  = true
    location = var.region

    weekly_schedule {
      # Run backup every day (all 7 days of the week).
      days_of_week = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
      start_times {
        # 02:00 local time — low-traffic window.
        hours   = 2
        minutes = 0
        seconds = 0
        nanos   = 0
      }
    }

    quantity_based_retention {
      count = local.backup_retention_days
    }

    # Backups also inherit cluster CMEK, but explicit encryption_config is still required here.
    encryption_config {
      kms_key_name = var.kms_key
    }
  }

  # Continuous backup (point-in-time recovery) — 14 days window gives us fine-grained recovery
  # without the storage cost of 30-day PITR in dev.
  continuous_backup_config {
    enabled              = true
    recovery_window_days = var.environment == "dev" ? 7 : 14
  }

  labels = local.labels

  lifecycle {
    # Prevent accidental cluster destruction — requires deliberate `terraform destroy -target`.
    prevent_destroy = true
  }
}

# Primary read/write instance.
resource "google_alloydb_instance" "primary" {
  cluster       = google_alloydb_cluster.main.name
  instance_id   = "${local.cluster_name}-primary"
  instance_type = "PRIMARY"

  machine_config {
    cpu_count = var.cpu_count
  }

  # pgvector is a database-level extension installed via CREATE EXTENSION — no
  # cluster-level flag needed. AlloyDB ships pgvector built-in and AlloyDB Omni
  # also supports it without any database flag. Setting `alloydb.enable_pgvector`
  # explicitly returns "DB flag with name 'alloydb.enable_pgvector' does not exist"
  # because that flag is not part of the AlloyDB instance configuration API.
  # To use pgvector after the cluster is up: `CREATE EXTENSION IF NOT EXISTS vector;`

  labels = local.labels

  depends_on = [google_alloydb_cluster.main]
}

# Read pool — only provisioned when var.enable_read_pool is true (prod).
# Matches primary CPU/memory so read queries don't starve relative to write path.
resource "google_alloydb_instance" "read_pool" {
  count = var.enable_read_pool ? 1 : 0

  cluster       = google_alloydb_cluster.main.name
  instance_id   = "${local.cluster_name}-read-pool"
  instance_type = "READ_POOL"

  read_pool_config {
    # Single read replica node; scale node_count in tfvars if read load grows.
    node_count = 1
  }

  machine_config {
    cpu_count = var.cpu_count
  }

  labels = local.labels

  depends_on = [google_alloydb_instance.primary]
}
