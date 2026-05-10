# Slice E — Object storage + document processing on GCS/Firestore

**Date:** 2026-04-21
**Scope:** Rip out S3 + DynamoDB from the document and attachment paths, replace with GCS + Firestore. SSD201 deployment is GCP-only — no dual-provider abstraction.
**Status:** Implemented (2026-05-09) with two material deviations:
  - **Job tracking on Postgres, not Firestore** (PR #19) — see PR for the deviation rationale (one fewer GCP service / SDK / IAM surface; workload fits Postgres easily; reuses Drizzle/migration patterns).
  - **E3 multipart→resumable upload was DELETED, not REWRITTEN** (PR #22). Survey of actual call sites found the `initiate-upload` / `confirm-upload` / `complete-multipart` trio had zero callers — the only client-facing upload path is the server-proxy route (`/api/documents/v2/upload`) per the school-firewall constraint documented in that route's header. Rather than rewrite routes nobody uses, the trio was reaped. If a future deployment needs direct-browser uploads (non-school context), build the resumable flow then.
**Companion:** [2026-04-19 GCP migration workbreakdown](./2026-04-19-gcp-migration-workbreakdown.md), [ADR-007](../architecture/adr/ADR-007-gcp-migration.md)

---

## What this slice does

Replaces the AWS S3 + DynamoDB surface used by the document upload, attachment storage, and image serving flows. The stash contains a prior attempt at this port; it is stale against dev's hardening PRs (#632, #880) and is being written fresh, not lifted. This slice does **not** touch safety (slice F), auth (slice G), or streaming metrics (slice H).

### Exit criterion

End-to-end document upload succeeds: user picks file → presigned GCS URL → browser PUT to GCS → Firestore job doc → file-processor (Cloud Run Job) reads object → writes extracted text + embeddings back → job marked complete → UI renders extracted content. Functional parity with the current S3 path, preserving dev's validation, rate limiting, and prompt-injection defenses.

---

## Current surface (what we're replacing)

### `lib/aws/s3-client.ts` — 423 LOC, 6 exported operations

| Operation | Called from | Purpose |
|---|---|---|
| `uploadDocument` | `lib/services/attachment-storage-service.ts`, nexus message handler | Direct server-side upload of small files |
| `getDocumentSignedUrl` | image route, repository actions, nexus messages | Issue read URLs for client-side fetch |
| `getObjectStream` | `lib/services/file-processing-service.ts`, `lib/ai/image-generation-service.ts` | Stream object contents for processing |
| `documentExists` | repository actions | Check before upload or link |
| `deleteDocument` | document route DELETE handler | Tear down on doc removal |
| `generateUploadPresignedUrl` | legacy `/api/documents/presigned-url` route | Pre-v2 upload path |

### `lib/aws/document-upload.ts` — 357 LOC, 5 exported operations

Multipart upload orchestration for v2 flow (`app/api/documents/v2/*`). Operations: `generateMultipartUrls`, `completeMultipartUpload`, `generatePresignedUrl`, `uploadToS3`, `sanitizeFileName`. Used by the v2 initiate / upload / complete / confirm endpoints.

### `lib/aws/lambda-trigger.ts` — 193 LOC

Invokes the `document-processor-v2` Lambda out-of-band after upload completion. Replaced by a Cloud Run Job invocation via Cloud Tasks or direct Cloud Run Jobs API.

### `lib/services/document-job-service.ts` — 442 LOC

DynamoDB-backed job tracker. Polled by the UI for progress. Firestore is the natural replacement.

### `lib/services/attachment-storage-service.ts` — 289 LOC

Server-side glue for persisting attachments referenced by Nexus conversations. Thin wrapper over `s3-client` + metadata storage.

### `lib/services/file-processing-service.ts` — 241 LOC

Runs inside the document-processor Lambda: fetches object, routes to the right parser (PDF, DOCX, XLSX, etc.), writes results back. Needs to move to Cloud Run Job.

### `infra/lambdas/document-processor-v2/`, `infra/lambdas/file-processor/`

Lambda source. Full rewrites as Cloud Run Jobs with Dockerfile + entrypoint. Infra part, not app part — coordinated with the Terraform slice.

---

## Replacement mapping

| AWS | GCP | Package | Notes |
|---|---|---|---|
| S3 object storage | GCS | `@google-cloud/storage` | Standard bucket, Uniform bucket-level access, CMEK via Cloud KMS |
| S3 presigned PUT | GCS V4 signed URL (PUT) | `@google-cloud/storage` | `getSignedUrl({ action: 'write', version: 'v4', expires })` |
| S3 multipart upload | GCS resumable upload | `@google-cloud/storage` | Browser uses XHR to resumable session URI; no multipart protocol |
| DynamoDB job tracker | Firestore document | `@google-cloud/firestore` | Collection: `document-jobs`; doc id = job id |
| DynamoDB conditional write | Firestore transaction | same | `runTransaction(tx => ...)` for status transitions |
| Lambda invoke (async) | Cloud Run Job + Cloud Tasks | `@google-cloud/run`, `@google-cloud/tasks` | Cloud Tasks enqueues, Cloud Run Job processes |
| SNS violation topic | Pub/Sub | `@google-cloud/pubsub` | Reused by slice F (safety) |
| Presigner auth (SigV4) | ADC / service account | `google-auth-library` | No credentials in app |

**Multipart → resumable: important behavior change.** S3 multipart splits a large file into many independently-uploaded parts and composes them server-side. GCS resumable is one continuous upload with session-based resumption — simpler from the app's side, but the browser code changes shape. The v2 route handlers (`initiate-upload`, `complete-multipart`, `confirm-upload`) collapse into two (`initiate-upload` → returns session URI, `confirm-upload` → marks job ready after GCS reports the object exists).

---

## Dev hardening to preserve

The stash pre-dates these and would discard them. They must carry forward into the GCS rewrite:

| PR | File | What it adds |
|---|---|---|
| #632 | `app/api/documents/v2/upload/route.ts` | Server-proxied upload (school firewalls block direct-to-S3); mirror by server-proxied streaming to GCS resumable URI |
| #632 R1 | same | Streaming upload (no full buffering), inline MIME validation, per-user rate limits |
| #880 | upload route + `UploadClassifiedError` | Typed error union, code-based error classification (no string coupling) |
| #880 R2 | same | Prompt-injection defenses on filename and metadata fields |
| #880 R3 | same | Round 3 review fixes — preserve cause chain in thrown errors, tighten throttling signal detection |
| d800eef6 | same | Security audit — eliminate prompt injection surface |
| 54601a85 | safe-message-code.ts | Safe-message lookup by error code (never expose raw error.message to the client) |

Implementation rule for this slice: every validation / rate-limit / error-code check in dev's current upload path is copied forward into the GCS route. If the GCS rewrite removes a check, it's a bug.

---

## PR sequence

Single large PR would be unreviewable. Sub-slice as follows:

### E1 — New GCP modules, no caller changes yet

- Add `@google-cloud/storage`, `@google-cloud/firestore` to `package.json`
- Write `lib/gcp/gcs-client.ts` — mirrors the exports of `lib/aws/s3-client.ts` 1:1 (same function names, same return shapes). Behavior: real GCS calls.
- Write `lib/gcp/firestore-jobs.ts` — mirrors `document-job-service.ts` exports with Firestore under the hood.
- Unit tests for both (mocking GCS/Firestore clients).
- No call site touches anything. CI green.

**Why same-name exports:** makes E2 a pure import rewrite, auditable in isolation.

### E2 — Swap imports at call sites

- For each of the ~15 caller files from the `@/lib/aws/*` survey: replace `from '@/lib/aws/s3-client'` with `from '@/lib/gcp/gcs-client'`, same for document-upload / document-job-service.
- No logic changes.
- Tests exercising the upload path updated to mock the GCS client instead of the S3 client.

### E3 — Resumable upload protocol change

- `/api/documents/v2/initiate-upload` returns a GCS resumable session URI instead of multipart upload ID + per-part URLs.
- Remove `/api/documents/v2/complete-multipart`.
- Keep `/api/documents/v2/confirm-upload`, now just verifies the object landed and flips the job status.
- Client-side upload code (whatever uses the multipart URLs) updated to do a single resumable PUT to the session URI.
- Explicitly preserves dev's server-proxy mode for the client firewall case (#632) — proxy streams through the Next.js server to the GCS resumable session.

### E4 — Retire `lib/aws/`

- Delete `lib/aws/` (the directory, not the file). All files.
- Remove `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-dynamodb`, `@aws-sdk/util-dynamodb`, `@aws-sdk/client-lambda` from `package.json`.
- Remove S3/DynamoDB env vars from `.env.example`.
- Ship when E3 is verified in dev GCP.

### E5 — Processor migration (separate track, coordinated with Terraform)

- `infra/lambdas/document-processor-v2/` → `infra/gcp/cloud-run-jobs/document-processor/` with Dockerfile + entrypoint.
- Triggered by Cloud Tasks enqueue from `/api/documents/v2/confirm-upload`, not direct invoke.
- Separate PR, lands alongside the Terraform that creates the Cloud Run Job resource.

---

## Open questions (decide before starting E1)

1. **CMEK on the GCS bucket** — yes or no for dev? Answer affects the `kms_key_name` on every `getSignedUrl` + upload call. Assume yes for prod/staging, mirror in dev for parity.
2. **Firestore database location** — single region vs multi-region. Affects latency from Cloud Run. Default suggestion: single-region `us-central1` matching the GKE/Cloud Run region.
3. **Bucket layout** — one bucket per env (`aistudio-dev-documents`, `aistudio-prod-documents`) or one bucket with path prefixes? Former is simpler; latter saves a project-quota item. Suggest former.
4. **Signed URL lifetime** — S3 default is currently 15 min in `s3-client.ts`. Preserve or tighten? Suggest 10 min for writes, 60 min for reads (shorter writes are safer against stolen URLs).
5. **School firewall proxy** — the server-proxy path from #632 adds latency on large uploads. Keep as default or make it fall-through-only? Default: keep as-is for behavior parity.

---

## Non-goals for this slice

- Safety layer (`lib/safety/*`) — separate slice against current dev
- Auth (`auth.ts`, Cognito) — separate slice
- Streaming/metrics (`lib/streaming/cloudwatch-metrics.ts`) — separate slice
- KMS token encryption (`lib/crypto/token-encryption.ts`) — separate slice
- Image generation / Bedrock image paths — separate slice

---

## Rollback

Revert the E-series PRs in reverse order. Because E1 is additive and E2 is a pure import swap, rollback to pre-slice state is a single revert per PR. E3 introduces a protocol change on the upload route — revert of E3 requires coordinated frontend deploy.
