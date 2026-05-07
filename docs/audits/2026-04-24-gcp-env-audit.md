# GCP env audit — 2026-04-24

Scope: staging/prod wiring for `VERTEX_AI_ENABLED`, `STORAGE_PROVIDER`, `GOOGLE_CLOUD_PROJECT`, and `GCS_BUCKET`.

## Evidence checked
- `.env.example`
- `.env.local`
- `infra-gcp/envs/staging/main.tf`
- `infra-gcp/envs/prod/main.tf`
- `lib/streaming/provider-adapters/vertex-adapter.ts`
- `lib/services/attachment-storage-service.ts`
- `lib/gcp/gcs-client.ts`

## Summary

| Variable | Local dev | Staging Cloud Run web | Prod Cloud Run web | Doc processor job | Notes / action |
| --- | --- | --- | --- | --- | --- |
| `VERTEX_AI_ENABLED` | Documented in `.env.example`; not set in `.env.local` | **Missing** | **Missing** | n/a | Required to flip migration routing on. Without it, `google` / `amazon-bedrock` stay on legacy adapters. |
| `STORAGE_PROVIDER` | Documented in `.env.example`; not set in `.env.local` | **Missing** | **Missing** | n/a | Required for web/API routes to select GCS instead of S3. Defaults to `aws-s3` when absent. |
| `GOOGLE_CLOUD_PROJECT` | Set in `.env.local` | **Missing** | **Missing** | Not explicitly set | `vertex-adapter.ts` hard-requires this env var in the web app. ADC alone is not enough for that code path today. |
| `GCS_BUCKET` | Documented in `.env.example`; not set in `.env.local` | **Missing** | **Missing** | **Configured** | `doc_processing_job` already receives `GCS_BUCKET = module.storage.buckets["doc-processing-staging"].name`. The web service does not. |

## Repo-state conclusions
- The **web service** Terraform env blocks for both staging and prod currently set only:
  - `DATABASE_URL`
  - `IDP_TENANT_ID`
  - `VERTEX_MODEL_ARMOR_TEMPLATE`
  - `NODE_ENV`
- That means the current GCP web deployment is **not yet wired** to turn on Vertex migration routing or GCS storage routing.
- The **doc processor Cloud Run Job** already receives `GCS_BUCKET`, but not the other three variables audited here.
- `.env.example` documents all four migration variables, so local/operator guidance exists, but infra wiring for staging/prod web is incomplete.

## Recommended staging/prod additions (no changes applied in this session)
Add these to the `cloud_run_web` `env` map in both `infra-gcp/envs/staging/main.tf` and `infra-gcp/envs/prod/main.tf` before rollout:

```hcl
VERTEX_AI_ENABLED    = "true"   # when ready to route google/bedrock through Vertex
STORAGE_PROVIDER     = "gcs"
GOOGLE_CLOUD_PROJECT = var.env_project_id
```

For `GCS_BUCKET`, the repo still needs an explicit bucket choice. Current app code uses a **single** storage bucket for both document uploads and conversation attachments, while Terraform currently provisions separate logical buckets (`attachments`, `repository-documents`, `doc-processing-staging`). Do not set this blindly during rollout; pick the target bucket intentionally or split the app config first.

## Risks if rolled out as-is
- Vertex migration code stays dormant even if the adapter exists.
- Storage reads/writes continue defaulting to S3 paths in the web app.
- If `STORAGE_PROVIDER=gcs` were set without `GCS_BUCKET`, `gcs-client.ts` would fall back to `DOCUMENTS_BUCKET_NAME` or `aistudio-documents`, which is too implicit for staging/prod.
- The web tier and doc processor could target different buckets if only one side is updated.
