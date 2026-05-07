# lib/gcp — GCP adapters for the AI Studio app layer

This directory houses the GCP-native replacements for `lib/aws/*`. It is being
populated slice-by-slice per
[docs/plans/2026-04-21-gcs-object-storage-slice.md](../../docs/plans/2026-04-21-gcs-object-storage-slice.md).

## Status

| File | Purpose | Slice | Status |
|---|---|---|---|
| `gcs-client.ts` | GCS object storage, 1:1 surface mirror of `lib/aws/s3-client.ts` | E1 | **Drafted** — signature parity, unit tests, not yet imported anywhere |
| `firestore-jobs.ts` | Firestore-backed replacement for `lib/services/document-job-service.ts` | E1 | Not started |
| `__tests__/gcs-client.test.ts` | Mocked `@google-cloud/storage` unit tests | E1 | **Drafted** |

## Design rules

1. **Same exports, same shapes.** Every function in `gcs-client.ts` has the
   same name and signature as its counterpart in `lib/aws/s3-client.ts`. E2's
   import-swap PR should be pure find-and-replace.
2. **Protocol changes are deferred to E3.** The presigned upload is currently
   a single-PUT V4 URL — resumable uploads come in E3 along with the
   `/api/documents/v2/*` route shape change.
3. **No runtime bucket creation.** Buckets are provisioned by
   `infra-gcp/modules/storage`; the app asserts reachability, it does not
   create infrastructure.
4. **Auth via ADC.** On Cloud Run the runtime service account supplies
   credentials automatically. Locally set `GOOGLE_APPLICATION_CREDENTIALS` to
   a service account key with Storage Object User on the target bucket.

## Required env vars

| Var | Default | Notes |
|---|---|---|
| `GCS_BUCKET` | `aistudio-documents` | Also falls back to `DOCUMENTS_BUCKET_NAME` for compatibility with existing deployments |
| `GCP_PROJECT_ID` | — | Also reads `GOOGLE_CLOUD_PROJECT`; both may be omitted on Cloud Run (ADC infers) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Local-only; path to a service account key JSON |

When `Settings.getGCS()` lands (follow-up task alongside E2), this module will
switch to the same cached-lookup pattern used by `Settings.getS3()` and these
env vars become the fallback, not the primary.

## Dev hardening preserved

Before E2 swaps imports, confirm every check listed in the "Dev hardening to
preserve" table in the slice plan (PRs #632, #880, d800eef6, 54601a85) is
present in the GCS code path. The S3 module does not currently implement most
of these — they live in the upload route handlers. This adapter is therefore
behavior-equivalent to S3 without the hardening regressing; the hardening
itself is preserved because E2 does not touch the route handlers.
