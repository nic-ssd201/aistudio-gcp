# Module: `sa-factory`

Creates a Google Service Account for an AI Studio workload and attaches **scoped, least-privilege IAM bindings** to the GCP resources it needs. Direct spiritual replacement for the CDK `ServiceRoleFactory` construct in the AWS tree.

## What it does

- Creates one `google_service_account` per call, with a stable `account_id`.
- Grants **default observability roles** (`logging.logWriter`, `monitoring.metricWriter`, `cloudtrace.agent`) unless explicitly disabled.
- Optionally grants `aiplatform.user` for Vertex access.
- Binds the SA to specific **GCS buckets**, **Secret Manager secrets**, **Cloud SQL instances** (with IAM condition scoping), **Pub/Sub topics**, and **Pub/Sub subscriptions** at the resource level — never via project-wide `*` grants.
- Provides an `additional_project_roles` escape hatch for unusual cases, with optional IAM conditions.

## What it does **not** do

- It does not attach the SA to a workload (Cloud Run service / Job, GCE VM, GKE pod). That's the consuming module's job — pass `module.sa_factory.email` as `service_account`.
- It does not create Cloud SQL database users for IAM auth. After `terraform apply`, the operator (or a follow-up Cloud Run Job) must run `CREATE USER "sa-<name>@<project>.iam";` on the target instance.
- It does not create the resources it binds to — pass them in by name. This keeps the module composable.

## Usage

```hcl
module "web_sa" {
  source = "../../modules/sa-factory"

  name        = "aistudio-web"
  project_id  = var.project_id
  environment = "dev"
  description = "Next.js SSR service account"

  storage_buckets = [
    { bucket = "aistudio-dev-uploads", role = "roles/storage.objectAdmin" },
    { bucket = "aistudio-dev-nexus",   role = "roles/storage.objectAdmin" },
  ]

  secrets = [
    { secret_id = "aistudio-dev-nextauth", role = "roles/secretmanager.secretAccessor" },
    { secret_id = "aistudio-dev-openai",   role = "roles/secretmanager.secretAccessor" },
  ]

  sql_instances = [
    { instance = "aistudio-dev-pg", role = "roles/cloudsql.client" },
  ]

  vertex_ai_enabled = true
}

resource "google_cloud_run_v2_service" "web" {
  # ...
  template {
    service_account = module.web_sa.email
    # ...
  }
}
```

## Inputs

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes | — | 2–24 chars, `[a-z0-9-]`. Becomes `sa-<name>`. Must be unique within the project. |
| `project_id` | string | yes | — | The GCP project that owns this SA. |
| `environment` | string | yes | — | One of `dev`, `staging`, `prod`. Applied as the `environment` label. |
| `description` | string | no | `""` | Free-text description visible in the GCP console. |
| `storage_buckets` | list(object) | no | `[]` | Per-bucket bindings. See schema below. |
| `secrets` | list(object) | no | `[]` | Per-secret bindings. |
| `sql_instances` | list(object) | no | `[]` | Project-level role, IAM-condition-scoped to the named instance. |
| `pubsub_topics` | list(object) | no | `[]` | Per-topic bindings. |
| `pubsub_subscriptions` | list(object) | no | `[]` | Per-subscription bindings. |
| `vertex_ai_enabled` | bool | no | `false` | Grants `roles/aiplatform.user` at project level. |
| `cloud_logging_enabled` | bool | no | `true` | `roles/logging.logWriter`. |
| `cloud_monitoring_enabled` | bool | no | `true` | `roles/monitoring.metricWriter`. |
| `cloud_trace_enabled` | bool | no | `true` | `roles/cloudtrace.agent`. |
| `additional_project_roles` | list(object) | no | `[]` | Escape hatch — see schema below. Each entry may include an IAM condition. |

### `storage_buckets[]`, `secrets[]`, `pubsub_topics[]`, `pubsub_subscriptions[]`, `sql_instances[]`

```hcl
list(object({
  bucket       = string  # or secret_id / topic / subscription / instance
  role         = string  # e.g. "roles/storage.objectAdmin"
}))
```

### `additional_project_roles[]`

```hcl
list(object({
  project = string
  role    = string
  condition = optional(object({
    title       = string
    description = optional(string)
    expression  = string       # CEL expression
  }))
}))
```

## Outputs

| Name | Description |
|---|---|
| `email` | SA email, for passing as `service_account` on Cloud Run etc. |
| `member` | `serviceAccount:<email>`, ready to pass to downstream `*_iam_member` resources. |
| `name` | Fully-qualified resource name. |
| `unique_id` | Numeric unique ID; useful for audit-log filters. |

## Cross-environment isolation

This module does not implement tag-based access conditions. GCP's per-project separation is the isolation primitive: a dev-env SA lives in the dev project and has no implicit access to any other project's resources. The `environment` variable is recorded as a label for audit and as a guardrail (validation pins it to `dev`/`staging`/`prod`), but does not itself change what the SA can reach.

If a caller needs stricter controls (e.g., "this SA may only access buckets with a `data-class=public` tag"), use `additional_project_roles` with a CEL `condition`.

## Testing

- `terraform validate` and `tflint` run in CI against the module directory.
- A Terratest harness (to be added in P0.3) applies the module to a scratch project, asserts the SA exists and has exactly the expected bindings (no more, no less), then destroys.

## Compatibility

- Terraform `>= 1.6.0`
- `hashicorp/google` `~> 6.0`

## Open questions for review

1. Should the default observability roles be opt-in instead of opt-out? Current default (opt-out) matches the AWS behavior where every workload had a `logs:PutLogEvents` grant.
2. Should Cloud SQL IAM conditions be relaxed for workloads that need Cloud SQL Admin API beyond `roles/cloudsql.client` (e.g. migrations runner)? Current stance: use `additional_project_roles` with an explicit condition.
3. Worth pre-creating the IAM DB user via Terraform (`google_sql_user` with `type = "CLOUD_IAM_SERVICE_ACCOUNT"`)? Current stance: no, because it couples the SA lifecycle to instance lifecycle; operator runs it as a post-apply step.
