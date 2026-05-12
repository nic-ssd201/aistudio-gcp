# Production environment — module composition
# Order follows integration-notes §3: foundation → data → identity/AI → compute → edge/ops → vpc-sc
# §6.1: Projects are pre-created; data sources only — no google_project resources.
# §6.6: Bootstrap lives in its own env root (envs/bootstrap). Apply that root FIRST.
#        Outputs are consumed here via terraform_remote_state.
# CRITICAL: Read all comments before applying. Many settings have first-apply vs. steady-state distinctions.

# ---------------------------------------------------------------------------
# Bootstrap remote state (§6.6 — bootstrap root applied separately)
# ---------------------------------------------------------------------------

data "terraform_remote_state" "bootstrap" {
  backend = "gcs"
  config = {
    bucket = "ssd201-aistudio-tfstate-shared"
    prefix = "bootstrap/prod"
  }
}

# ---------------------------------------------------------------------------
# Project data sources (§6.1 — adopt pre-created projects, never create)
# ---------------------------------------------------------------------------

data "google_project" "env" {
  project_id = var.env_project_id
}

# ---------------------------------------------------------------------------
# 1. Foundation — kms, network, iam
# ---------------------------------------------------------------------------

module "kms" {
  source = "../../modules/kms"

  project_id   = var.env_project_id
  environment  = var.environment
  region       = var.region
  keyring_name = "aistudio-prod"

  signing_keys = {
    jwt-signing = {
      purpose = "OAuth2/OIDC RS256 JWT signing"
    }
  }

  labels = { environment = var.environment, managed_by = "terraform" }
}

# Grant the Cloud Run web SA permission to sign JWTs and fetch the public key.
# Provisioned at the env level (not in the kms module) because module.sa_web is
# defined further down — see staging/main.tf for the same pattern.
resource "google_kms_crypto_key_iam_member" "jwt_signing_signer" {
  crypto_key_id = module.kms.signing_key_ids["jwt-signing"]
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${module.sa_web.email}"
}

module "network" {
  source = "../../modules/network"

  project_id  = var.env_project_id
  environment = var.environment
  region      = var.region
  vpc_name    = "aistudio-vpc"

  subnet_cidrs = {
    web              = "10.0.1.0/24"
    jobs             = "10.0.2.0/24"
    private-services = "10.0.3.0/24"
  }

  enable_flow_logs     = true
  enable_firewall_logs = true
  enable_iap_ssh       = false # prod: no IAP SSH; breakglass via Cloud Shell only
  # Egress deny-all is false on first apply — enable once VPC-SC dry-run is clean
  # and deny-all egress rules are verified not to block essential GCP API traffic.
  firewall_deny_all_egress = false

  labels = { environment = var.environment, managed_by = "terraform" }
}

module "iam" {
  source = "../../modules/iam"

  project_id  = var.env_project_id
  environment = var.environment
  region      = var.region

  service_accounts = {}
  role_bindings    = []

  # Bindings for the prior cloud-run-job pipeline are gone — see staging/main.tf
  # for the rationale; the new path uses inline google_cloud_run_v2_service_iam_member.
  run_invoker_bindings       = []
  eventarc_receiver_bindings = []

  labels = { environment = var.environment, managed_by = "terraform" }
}

# ---------------------------------------------------------------------------
# 2. Per-workload service accounts (sa-factory — one invocation per workload)
# ---------------------------------------------------------------------------

module "sa_web" {
  source = "../../modules/sa-factory"

  project_id  = var.env_project_id
  environment = var.environment
  name        = "web"
  description = "AI Studio Cloud Run web service SA"

  vertex_ai_enabled        = true
  cloud_logging_enabled    = true
  cloud_monitoring_enabled = true
  cloud_trace_enabled      = true
}

module "sa_doc_proc" {
  source = "../../modules/sa-factory"

  project_id  = var.env_project_id
  environment = var.environment
  name        = "doc-proc"
  description = "Document processing Cloud Run Job SA"

  cloud_logging_enabled    = true
  cloud_monitoring_enabled = true
  cloud_trace_enabled      = true
}

module "sa_scheduler" {
  source = "../../modules/sa-factory"

  project_id  = var.env_project_id
  environment = var.environment
  name        = "scheduler"
  description = "Cloud Scheduler invoker SA"

  cloud_logging_enabled    = true
  cloud_monitoring_enabled = false
  cloud_trace_enabled      = false
}

# ---------------------------------------------------------------------------
# 3. Data layer — secrets, storage, alloydb
# ---------------------------------------------------------------------------

module "secrets" {
  source = "../../modules/secrets"

  project_id  = var.env_project_id
  environment = var.environment
  region      = var.region
  kms_key     = module.kms.key_ids["secrets"]

  secrets = {
    "aistudio-nextauth-secret" = {
      description        = "NextAuth session secret"
      accessor_sa_emails = [module.sa_web.email]
    }
    "aistudio-mcp-token" = {
      description        = "MCP API bearer token"
      accessor_sa_emails = [module.sa_web.email, module.sa_doc_proc.email]
    }
    "alloydb-initial-password" = {
      description        = "AlloyDB postgres initial user password (set via gcloud secrets versions add)"
      accessor_sa_emails = []
    }
    "aistudio-mcp-token-encryption-key" = {
      description        = "DEK seed for MCP per-user OAuth token field-level encryption (consumed by lib/crypto/token-encryption.ts)"
      accessor_sa_emails = [module.sa_web.email]
    }
  }

  labels = { environment = var.environment, managed_by = "terraform" }
}

module "storage" {
  source = "../../modules/storage"

  project_id  = var.env_project_id
  environment = var.environment
  kms_key     = module.kms.key_ids["storage"]
  name_prefix = "ssd201-aistudio" # GCS bucket names are global; org-namespace required

  # audit-logs bucket: is_locked = false on first apply.
  # Flip to true only with district records officer signoff (Vault review gate §6.5).
  # The storage module handles is_locked per bucket spec — update bucket spec when gate clears.
  labels = { environment = var.environment, managed_by = "terraform" }
}

module "alloydb" {
  source = "../../modules/alloydb"

  project_id   = var.env_project_id
  environment  = var.environment
  region       = var.region
  cluster_name = "aistudio-prod"

  vpc_self_link                = module.network.vpc_self_link
  psa_range                    = module.network.psa_range
  kms_key                      = module.kms.key_ids["alloydb"]
  cpu_count                    = 4    # prod: 4 CPUs per spec §3.6
  enable_read_pool             = true # prod: read pool enabled
  # secret_version_refs[...].name is the clean secret resource path; the alloydb
  # module's data source appends `version = "latest"` itself. See envs/dev/main.tf
  # for the explanation.
  initial_user_password_secret = module.secrets.secret_version_refs["alloydb-initial-password"].name

  labels = { environment = var.environment, managed_by = "terraform" }
}

# ---------------------------------------------------------------------------
# 4. Identity & AI
# ---------------------------------------------------------------------------

module "identity_platform" {
  source = "../../modules/identity-platform"

  project_id          = var.env_project_id
  environment         = var.environment
  tenant_display_name = "SSD Staff"
  authorized_domains  = [var.domain_name]

  oidc_providers = [{
    display_name        = "Google Workspace"
    client_id           = var.workspace_oidc_client_id
    issuer              = "https://accounts.google.com"
    client_secret_value = var.workspace_oidc_client_secret
  }]

  labels = { environment = var.environment, managed_by = "terraform" }
}

module "vertex" {
  source = "../../modules/vertex"

  project_id           = var.env_project_id
  region               = var.region
  environment          = var.environment
  enable_claude_models = true
  cloud_run_sa_email   = module.sa_web.email

  model_armor_templates = {
    "aistudio-default" = {}
  }

  labels = { environment = var.environment, managed_by = "terraform" }
}

module "dlp" {
  source = "../../modules/dlp"

  project_id  = var.env_project_id
  environment = var.environment

  job_triggers = [
    { bucket = module.storage.buckets["attachments"].name },
    { bucket = module.storage.buckets["repository-documents"].name },
  ]

  labels = { environment = var.environment, managed_by = "terraform" }
}

# ---------------------------------------------------------------------------
# 5. Compute — cloud-run-web and doc-processing job
# ---------------------------------------------------------------------------

module "cloud_run_web" {
  source = "../../modules/cloud-run-web"

  project_id            = var.env_project_id
  environment           = var.environment
  region                = var.region
  service_account_email = module.sa_web.email
  image                 = var.container_image
  vpc_connector         = module.network.serverless_connector_name

  min_instances        = var.cloud_run_min_instances # prod default: 2
  max_instances        = var.cloud_run_max_instances # prod default: 100
  cpu_always_allocated = true                        # prod: CPU always-on

  concurrency = 80

  # §6.4: first apply = latest-100.
  # After first deploy, blue/green is driven by the deployment pipeline setting
  # traffic_revision in a targeted plan+apply — not managed here directly.
  traffic_revision = ""

  secret_refs = {
    NEXTAUTH_SECRET    = module.secrets.version_refs["aistudio-nextauth-secret"]
    AISTUDIO_MCP_TOKEN = module.secrets.version_refs["aistudio-mcp-token"]
    DB_PASSWORD        = module.secrets.version_refs["alloydb-initial-password"]
  }

  env = {
    DB_HOST                     = module.alloydb.primary_private_ip
    DB_USER                     = "postgres"
    DB_NAME                     = "aistudio"
    IDP_TENANT_ID               = module.identity_platform.tenant_id
    VERTEX_MODEL_ARMOR_TEMPLATE = module.vertex.model_armor_template_names["aistudio-default"]
    NODE_ENV                    = "production"
    GOOGLE_CLOUD_PROJECT        = var.env_project_id
    GCP_PROJECT_ID              = var.env_project_id
    ENVIRONMENT                 = var.environment
    # Active KMS key version for OAuth2/OIDC JWT signing. KMS does NOT auto-rotate
    # asymmetric keys; when rotation is needed, create a new version with
    # `gcloud kms keys versions create` and bump this path to cryptoKeyVersions/N.
    KMS_SIGNING_KEY_NAME = "${module.kms.signing_key_ids["jwt-signing"]}/cryptoKeyVersions/1"
    # Document-processing pipeline producer wiring (see staging for rationale).
    PROCESSING_QUEUE_NAME = module.doc_processing_queue.queue_id
    PROCESSING_TARGET_URL = "${module.doc_processor_worker.service_url}/process-job"
    PROCESSING_INVOKER_SA = module.sa_doc_proc.email
  }

  labels = { environment = var.environment, managed_by = "terraform" }
}

# ---------------------------------------------------------------------------
# Document-processing pipeline (see staging/main.tf for the design rationale).
# ---------------------------------------------------------------------------

module "doc_processing_queue" {
  source = "../../modules/cloud-tasks-queue"

  project_id  = var.env_project_id
  environment = var.environment
  region      = var.region
  queue_name  = "aistudio-doc-processing"

  # Prod: lift caps slightly to handle a busier fleet, but still bound to
  # protect the worker from a runaway producer.
  max_dispatches_per_second = 25
  max_concurrent_dispatches = 20

  labels = { environment = var.environment, managed_by = "terraform" }
}

module "doc_processor_worker" {
  source = "../../modules/cloud-run-worker"

  project_id            = var.env_project_id
  environment           = var.environment
  region                = var.region
  service_name          = "aistudio-doc-processor"
  service_account_email = module.sa_doc_proc.email
  image                 = var.doc_processor_image
  vpc_connector         = module.network.serverless_connector_name

  request_timeout_seconds = 1800
  memory                  = "4Gi"
  cpu                     = "2"
  max_instances           = 50

  secret_refs = {
    DB_PASSWORD = module.secrets.version_refs["alloydb-initial-password"]
  }

  env = {
    DB_HOST              = module.alloydb.primary_private_ip
    DB_USER              = "postgres"
    DB_NAME              = "aistudio"
    GCS_BUCKET           = module.storage.buckets["attachments"].name
    GOOGLE_CLOUD_PROJECT = var.env_project_id
    GCP_PROJECT_ID       = var.env_project_id
    ENVIRONMENT          = var.environment
    NODE_ENV             = "production"
    # See staging/main.tf for audience-derivation rationale.
    PROCESSOR_INVOKER_SA   = module.sa_doc_proc.email
    CLEANUP_INVOKER_SA     = module.sa_scheduler.email
    CLEANUP_RETENTION_DAYS = "7"
  }

  labels = { environment = var.environment, managed_by = "terraform" }
}

resource "google_cloud_tasks_queue_iam_member" "web_enqueuer" {
  project  = var.env_project_id
  location = var.region
  name     = module.doc_processing_queue.queue_name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${module.sa_web.email}"
}

resource "google_cloud_run_v2_service_iam_member" "tasks_invoker" {
  project  = var.env_project_id
  location = var.region
  name     = module.doc_processor_worker.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.sa_doc_proc.email}"
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.env_project_id
  location = var.region
  name     = module.doc_processor_worker.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.sa_scheduler.email}"
}

# ---------------------------------------------------------------------------
# 6. Edge — load balancer
# ---------------------------------------------------------------------------

module "lb" {
  source = "../../modules/lb"

  project_id             = var.env_project_id
  environment            = var.environment
  region                 = var.region
  cloud_run_service_name = module.cloud_run_web.service_name
  cloud_run_region       = var.region

  domains        = [var.domain_name]
  rate_limit_rpm = 1000 # prod: rate + OWASP; bot mgmt configurable in lb module
  enable_cdn     = true

  labels = { environment = var.environment, managed_by = "terraform" }
}

# ---------------------------------------------------------------------------
# 7. Ops — scheduler, observability
# ---------------------------------------------------------------------------

module "scheduler" {
  source = "../../modules/scheduler"

  project_id         = var.env_project_id
  environment        = var.environment
  region             = var.region
  scheduler_sa_email = module.sa_scheduler.email

  jobs = {
    "doc-jobs-cleanup-nightly" = {
      schedule    = "0 2 * * *"
      time_zone   = "America/Los_Angeles"
      target_type = "url"
      url         = "${module.doc_processor_worker.service_url}/admin/cleanup-jobs"
      http_method = "POST"
    }
  }

  labels = { environment = var.environment, managed_by = "terraform" }
}

module "observability" {
  source = "../../modules/observability"

  project_id  = var.env_project_id
  environment = var.environment
  region      = var.region
  name_prefix = "ssd201-aistudio" # FERPA audit GCS bucket — global namespace

  audit_logs_bucket   = module.storage.buckets["audit-logs"].name
  ferpa_audit_kms_key = module.kms.key_ids["audit-logs"]

  # §6.2: Real budget alerts live in bootstrap/budgets.tf (google_billing_budget).
  # This threshold drives the observability log-based proxy metric — a distinct FERPA tripwire.
  budget_alert_threshold = var.budget_amount_usd

  alert_channels = var.alert_channels

  uptime_urls = [{
    display_name = "aistudio-prod"
    host         = var.domain_name
    path         = "/api/health"
    use_ssl      = true
    validate_ssl = true
  }]

  labels = { environment = var.environment, managed_by = "terraform" }
}

# ---------------------------------------------------------------------------
# 8. VPC-SC — LAST
# §6.4: enforce_mode = false on first apply for ALL envs.
# Promote to true after: (a) 7 days zero unexpected violations in dry-run,
# (b) Vault review of ingress rules, (c) Nic signoff.
# ---------------------------------------------------------------------------

module "vpc_sc" {
  source = "../../modules/vpc-sc"

  access_policy_name = var.vpc_sc_access_policy_name
  perimeter_name     = "aistudio_prod_perimeter"
  environment        = var.environment
  project_numbers    = [data.google_project.env.number]

  # Default false — override to true only after gate conditions above are met
  enforce_mode = var.enable_vpc_sc_enforce

  labels = { environment = var.environment, managed_by = "terraform" }
}

# GCS service agent member — looked up here so module.iam can reference it.
# (The prior google_storage_project_service_account data source + cross-cutting
# eventarc/run_invoker bindings were removed when the doc-processing pipeline
# moved from cloud-run-job + Eventarc to Cloud Tasks + cloud-run-worker.
# IAM grants for the new pipeline are inline next to the worker module.)
#
# §6.6: Budget is managed in envs/bootstrap. The breakglass_channel_id output is available
# from data.terraform_remote_state.bootstrap.outputs.breakglass_channel_id and can be
# passed to the observability module as a fallback channel in a future pass.
