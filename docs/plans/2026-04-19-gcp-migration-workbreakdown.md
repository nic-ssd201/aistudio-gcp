# GCP Migration — Work Breakdown

**Date:** 2026-04-19
**Scope:** Extra-large — eight phases
**Status:** Draft for review
**Companion:** [ADR-007: Migration from AWS to GCP](../architecture/adr/ADR-007-gcp-migration.md)

---

## How to read this doc

This is a ticket-sized breakdown of ADR-007. Every phase opens with an **epic** that you can paste into `gh issue create`; the numbered tasks below it are the child issues. Each task has a title, labels, dependencies, an effort estimate, a short body, and acceptance criteria.

Effort legend: **XS** < 0.5d, **S** ≈ 1d, **M** ≈ 2–3d, **L** ≈ 4–7d, **XL** > 1 sprint.

Nothing here assumes a start date — phases are partially overlapping and should be scheduled once Phase 0 exits.

---

## Phase 0 — Foundation

### Epic P0 — GCP foundations in place
**Labels:** `epic`, `phase-0`, `gcp-migration`
**Exit criterion:** `terraform apply` across dev/staging/prod produces a VPC, Artifact Registry, and an empty Cloud Run returning 200 on `/healthz`. CI has a working `deploy-gcp-dev` job.
**Rollback:** delete the projects. No production impact.

#### P0.1 — Create GCP projects (dev/staging/prod) under folder `aistudio`
**Labels:** `phase-0`, `foundation`, `org-admin`
**Depends on:** —
**Effort:** S

Stand up three projects under the `openclaw` org with the folder structure decided by org admins. Apply default labels `{ environment, managed-by=terraform }`. Enable billing export to BigQuery.

**Acceptance:**
- [ ] `openclaw-gog-487717` (dev, existing), `aistudio-staging`, `aistudio-prod` all exist
- [ ] Billing linked, budget alerts configured per env
- [ ] Billing export dataset created
- [ ] Default labels applied project-wide

#### P0.2 — Bootstrap Terraform remote state in GCS
**Labels:** `phase-0`, `foundation`, `terraform`
**Depends on:** P0.1
**Effort:** S

Create a dedicated `aistudio-tf-state` project with a GCS bucket per env (`…-tfstate-dev` etc.), versioned, uniform-access, CMEK. Seed `/infra-gcp/envs/{dev,staging,prod}/backend.tf` with remote state config.

**Acceptance:**
- [ ] State buckets created, versioned, encrypted
- [ ] `terraform init` works from each env dir
- [ ] State locking via GCS object-level locks confirmed with a concurrency test

#### P0.3 — Write `sa-factory` Terraform module
**Labels:** `phase-0`, `foundation`, `terraform`, `security`
**Depends on:** P0.2
**Effort:** M

Build the spiritual successor to the CDK `ServiceRoleFactory`. Module creates a service account and scoped IAM bindings for GCS buckets, Secret Manager secrets, Cloud SQL instances, Pub/Sub topics, Vertex AI, and default logs/metrics/trace roles. Scaffolded at `/infra-gcp/modules/sa-factory/` — see the module README for the interface.

**Acceptance:**
- [ ] Module passes `terraform validate` and `tflint`
- [ ] Unit-tested with Terratest against a scratch project
- [ ] README documents the interface and the cross-env isolation model
- [ ] Used by at least one downstream module (`cloud-run` in P0.7) before merge

#### P0.4 — Write `network` module (VPC, subnets, NAT, PSA, Serverless VPC Access)
**Labels:** `phase-0`, `foundation`, `terraform`, `networking`
**Depends on:** P0.2
**Effort:** M

One VPC per env; regional private subnets; Cloud NAT; Private Services Access range for Cloud SQL; Serverless VPC Access connector sized for Cloud Run. Firewall rules default-deny with explicit ingress allow-lists. Output: subnet IDs, connector ID, PSA range name.

**Acceptance:**
- [ ] VPC + subnets + NAT apply cleanly in dev
- [ ] Cloud SQL PSA range reserved and peered
- [ ] Serverless VPC Access connector reachable from a test Cloud Run
- [ ] Firewall logs enabled

#### P0.5 — Create Artifact Registry repos per env
**Labels:** `phase-0`, `foundation`, `terraform`, `ci`
**Depends on:** P0.2
**Effort:** XS

Docker-format repos named `aistudio-web`. CMEK on prod. Vulnerability scanning enabled.

**Acceptance:**
- [ ] Three repos exist
- [ ] `docker push` from a dev workstation succeeds against dev repo
- [ ] Image scan report visible in console

#### P0.6 — GitHub Actions `deploy-gcp-dev` workflow (parallel to AWS deploys)
**Labels:** `phase-0`, `foundation`, `ci`
**Depends on:** P0.5
**Effort:** M

New workflow builds the existing Dockerfile, tags with the commit SHA, pushes to Artifact Registry, applies Terraform for dev. Uses Workload Identity Federation — no long-lived keys in GitHub secrets.

**Acceptance:**
- [ ] WIF trust configured between `psd401/aistudio` and `aistudio-dev` project
- [ ] Workflow runs green on a PR against `dev`
- [ ] AWS workflow is unaffected

#### P0.7 — Minimal Cloud Run service: empty healthz
**Labels:** `phase-0`, `foundation`, `terraform`, `compute`
**Depends on:** P0.3, P0.4, P0.5
**Effort:** S

A Terraform `cloud-run` module that uses `sa-factory`, Serverless VPC Access, and Artifact Registry. Ships the existing image but with an env var that short-circuits to just `/api/healthz`. Proves the whole P0 pipeline without touching business logic.

**Acceptance:**
- [ ] Cloud Run service returns 200 on `/api/healthz`
- [ ] Cloud Logging shows the structured log line from `@/lib/logger`
- [ ] Cloud Monitoring shows request_count metric

#### P0.8 — Terraform review & merge into `main`
**Labels:** `phase-0`, `foundation`, `terraform`
**Depends on:** P0.3–P0.7
**Effort:** S

PR review, address feedback, merge `/infra-gcp/` as the canonical GCP infra tree. Document the conventions (module layout, naming, labeling) in `/infra-gcp/README.md`.

---

## Phase 1 — Auth

### Epic P1 — Google SSO in all environments, Cognito removed
**Labels:** `epic`, `phase-1`, `gcp-migration`, `auth`
**Exit criterion:** `AUTH_PROVIDER=google` in all envs, zero Cognito calls in last 7 days of logs.
**Rollback:** flip `AUTH_PROVIDER=cognito`; Cognito pool still exists until P7.

#### P1.1 — Domain policy review (Workspace restrictions)
**Labels:** `phase-1`, `auth`, `policy`
**Depends on:** —
**Effort:** XS

Confirm with org admins whether Google sign-in should be domain-restricted. Document the decision in this issue.

**Acceptance:**
- [ ] Decision recorded with approver name
- [ ] If restricted: hosted domain (`hd`) param set in NextAuth Google provider config

#### P1.2 — Cognito-to-Google account linking audit
**Labels:** `phase-1`, `auth`, `data`
**Depends on:** —
**Effort:** S

Query the current user table + Cognito pool. Count users whose Cognito email does/doesn't match a valid Google identity in the allowed domains. Produce a manifest of users who will need admin-assisted migration.

**Acceptance:**
- [ ] CSV of affected users committed to a private gist
- [ ] Runbook for admin-assisted migration drafted

#### P1.3 — Deploy `AUTH_PROVIDER=google` to staging
**Labels:** `phase-1`, `auth`, `deploy`
**Depends on:** P1.1
**Effort:** S

Staging already deployable to GCP from P0. Flip the flag, invite 3–5 internal users, smoke test full auth flow.

**Acceptance:**
- [ ] Fresh Google sign-in creates upserted user row
- [ ] Returning user sign-in links by `sub` successfully
- [ ] Session cookies work across reloads and tab switches

#### P1.4 — Deploy `AUTH_PROVIDER=google` to prod
**Labels:** `phase-1`, `auth`, `deploy`
**Depends on:** P1.3
**Effort:** S

Phased rollout: admins first, then staff, then students. Comms email drafted and approved before flipping.

**Acceptance:**
- [ ] 100% of sign-ins in the last 24h are Google
- [ ] Support volume within normal baseline

#### P1.5 — Rotate NextAuth secret and session cookies
**Labels:** `phase-1`, `auth`, `security`
**Depends on:** P1.4
**Effort:** XS

New `NEXTAUTH_SECRET` generated, stored in Secret Manager, deployed. Existing sessions invalidated (users re-sign-in once).

**Acceptance:**
- [ ] Secret rotated in all envs
- [ ] Old cookie value rejected

#### P1.6 — Rip-out: remove Cognito provider code
**Labels:** `phase-1`, `auth`, `cleanup`
**Depends on:** P1.5 (+14 day stable window)
**Effort:** S

Delete `lib/auth/cognito-*`, NextAuth Cognito provider config, Cognito env vars from `.env.example` and CI. Cognito CDK stack stays until P7 for rollback safety.

**Acceptance:**
- [ ] `grep -r -i cognito lib/ app/` returns empty
- [ ] `typecheck` green
- [ ] E2E auth tests green

---

## Phase 2 — AI providers

### Epic P2 — Vertex AI is the live Claude path, Bedrock removed
**Labels:** `epic`, `phase-2`, `gcp-migration`, `ai`
**Exit criterion:** zero Bedrock invocations in prod for 14 consecutive days.
**Rollback:** flip affected `ai_models` rows back to `amazon-bedrock`.

#### P2.1 — Add Claude-on-Vertex rows to `ai_models`
**Labels:** `phase-2`, `ai`, `data`
**Depends on:** —
**Effort:** XS

Seed rows for Claude Sonnet / Haiku / Opus via Vertex alongside the existing Bedrock rows. Initially hidden from end-users.

**Acceptance:**
- [ ] Rows visible only to admin role
- [ ] Model selector loads both paths

#### P2.2 — Grant Cloud Run SA `roles/aiplatform.user` + per-env budget
**Labels:** `phase-2`, `ai`, `terraform`, `security`
**Depends on:** P0.3
**Effort:** XS

Use the `sa-factory` module's `vertex_ai_enabled=true`. Enable billing budget alert on Vertex spend per env.

**Acceptance:**
- [ ] Vertex call from staging Cloud Run succeeds end-to-end
- [ ] Budget alert fires at 50% / 90% / 100%

#### P2.3 — Build Bedrock↔Vertex parity eval harness
**Labels:** `phase-2`, `ai`, `testing`
**Depends on:** P2.1, P2.2
**Effort:** M

Fixed prompt set (~50 prompts across categories: code, summarization, reasoning, RAG). Run against both providers. Record outputs, cost, latency. Surface obvious regressions (output length, refusal rate, tool-use success).

**Acceptance:**
- [ ] Harness runs via `bun run eval:providers`
- [ ] Results persisted to a spreadsheet for reviewer sign-off
- [ ] No P0 regressions blocking promotion

#### P2.4 — Admin UI: flip `provider` column per `ai_models` row
**Labels:** `phase-2`, `ai`, `ui`
**Depends on:** P2.1
**Effort:** M

Add a small admin control (under existing admin model management UI) to set `provider` on a row. Audit-log the change. Currently this field is seeded at startup — this issue makes it editable.

**Acceptance:**
- [ ] Admin can flip a row from `amazon-bedrock` to `google-vertex` without a deploy
- [ ] Change is audit-logged
- [ ] Running conversations aren't disrupted (new messages use new provider)

#### P2.5 — Phased cutover, 14-day monitor
**Labels:** `phase-2`, `ai`, `deploy`
**Depends on:** P2.3, P2.4
**Effort:** S

Flip rows in order: admin-only models first, then staff, then students. Monitor daily Bedrock invocation count in CloudWatch — target zero for 14 consecutive days.

**Acceptance:**
- [ ] Cutover log of flip times committed to this issue
- [ ] Zero-Bedrock confirmation screenshot at 14 days

#### P2.6 — Rip-out: delete Bedrock provider code
**Labels:** `phase-2`, `ai`, `cleanup`
**Depends on:** P2.5
**Effort:** S

Delete `createBedrockModel` case from `provider-factory.ts`, drop `@ai-sdk/amazon-bedrock` from `package.json`, drop `BedrockStack` in CDK.

**Acceptance:**
- [ ] `grep -r amazon-bedrock lib/ app/ infra/` returns empty
- [ ] `bun run lint && bun run typecheck` green

---

## Phase 3 — Storage

### Epic P3 — All uploads live in GCS, S3 decommissioned
**Labels:** `epic`, `phase-3`, `gcp-migration`, `storage`
**Exit criterion:** `STORAGE_PROVIDER=gcs` in prod for 14 days; S3 read traffic zero.
**Rollback:** flip `STORAGE_PROVIDER` back; S3 still holds dual-written copy.

#### P3.1 — Terraform `storage` module: GCS buckets per env
**Labels:** `phase-3`, `storage`, `terraform`
**Depends on:** P0.3
**Effort:** S

Three buckets per env (`aistudio-{env}-uploads`, `…-nexus`, `…-repositories`) with uniform access, CMEK, lifecycle (Nearline @ 30d, Coldline @ 90d), versioning on Nexus.

**Acceptance:**
- [ ] Buckets created; `sa-factory` binds scoped roles
- [ ] Lifecycle rules visible in console

#### P3.2 — Storage Transfer Service: S3→GCS backfill
**Labels:** `phase-3`, `storage`, `data-migration`
**Depends on:** P3.1
**Effort:** M

One-time transfer job per bucket. Runs overnight. Checksums verified. Rerun-safe.

**Acceptance:**
- [ ] All S3 objects present in target GCS bucket
- [ ] Sample-of-100 byte-equal check passes

#### P3.3 — Dual-write flag in staging
**Labels:** `phase-3`, `storage`, `deploy`
**Depends on:** P3.1, P3.2
**Effort:** S

`STORAGE_PROVIDER=gcs` with an internal flag `STORAGE_DUAL_WRITE=true` that also writes to S3. Used for the overlap period.

**Acceptance:**
- [ ] New uploads in staging appear in both buckets
- [ ] Read traffic 100% on GCS
- [ ] Zero upload errors over 48h

#### P3.4 — Dual-write rollout to prod
**Labels:** `phase-3`, `storage`, `deploy`
**Depends on:** P3.3
**Effort:** S

Same flags in prod. Watch for Nexus 500MB attachment edge cases specifically (the largest single-object path).

**Acceptance:**
- [ ] 14-day clean window with dual-write active
- [ ] Nexus attachment over 400MB verified working

#### P3.5 — Turn off dual-write; GCS sole source of truth
**Labels:** `phase-3`, `storage`, `deploy`
**Depends on:** P3.4
**Effort:** XS

Set `STORAGE_DUAL_WRITE=false`. Monitor S3 PUT traffic → zero.

**Acceptance:**
- [ ] S3 PUT count 0 for 14 days

#### P3.6 — Rip-out: delete S3 adapter code
**Labels:** `phase-3`, `storage`, `cleanup`
**Depends on:** P3.5
**Effort:** S

Delete `lib/aws/s3-*.ts` (rename `lib/aws/document-upload.ts` to `lib/storage/gcs-upload.ts`), drop `@aws-sdk/client-s3`, drop `StorageStack`. S3 buckets themselves stay for 90-day retention per ADR-007; they are lifecycle-archived and deleted in P7.

**Acceptance:**
- [ ] `grep -r @aws-sdk/client-s3 .` returns empty
- [ ] Upload E2E tests green

---

## Phase 4 — Database

### Epic P4 — Prod on Cloud SQL, Aurora cold
**Labels:** `epic`, `phase-4`, `gcp-migration`, `database`, `high-risk`
**Exit criterion:** prod on Cloud SQL for 14 days with no unplanned failover; embedding search p95 within 10% of Aurora baseline.
**Rollback:** reverse-replication window (~24h) post-cut; beyond that, data-merge required. Plan assumes a feature freeze during cutover week.

#### P4.1 — Terraform `cloud-sql` module: Postgres 16 + pgvector
**Labels:** `phase-4`, `database`, `terraform`
**Depends on:** P0.4
**Effort:** M

HA regional Cloud SQL in prod, ZONAL in dev. pgvector + uuid-ossp + pg_stat_statements enabled on first boot via a startup script. PITR enabled. Weekly backups, 30-day retention prod.

**Acceptance:**
- [ ] `terraform apply` produces a working instance
- [ ] `SELECT version()` returns Postgres 16
- [ ] `SELECT extname FROM pg_extension` includes `vector`

#### P4.2 — Migrations runner: Cloud Run Job from `/infra/database/schema/`
**Labels:** `phase-4`, `database`, `infra`
**Depends on:** P4.1
**Effort:** M

Job container runs the same migration SQL files we use today, in order, from `migrationFiles` in `migrations.json`. Idempotent. Fails loud on schema drift.

**Acceptance:**
- [ ] Empty Cloud SQL → fully migrated after one Job run
- [ ] Re-running the Job is a no-op
- [ ] Failure exit code 1 surfaces in Cloud Monitoring

#### P4.3 — App: dual-connect via `DATABASE_URL_PRIMARY` / `DATABASE_URL_SHADOW`
**Labels:** `phase-4`, `database`, `app`
**Depends on:** P4.1
**Effort:** M

Add a read-path shadow against the secondary. Results compared (row count, hashed payload) — discrepancies logged, never returned to user. Writes go only to primary.

**Acceptance:**
- [ ] Read shadowing enabled in dev with Aurora primary, Cloud SQL shadow
- [ ] Discrepancy metric emitted to Cloud Monitoring
- [ ] Zero discrepancies on a 24h run against representative traffic

#### P4.4 — Logical replication Aurora → Cloud SQL
**Labels:** `phase-4`, `database`, `data-migration`
**Depends on:** P4.1
**Effort:** L

Decision: `pglogical` vs Datastream. Prefer Datastream for managed ops. Excludes system schemas and temp tables. Replication lag monitored, alerts at >30s.

**Acceptance:**
- [ ] Replication live, steady-state lag <5s
- [ ] Lag alert tested (artificial lag injection)

#### P4.5 — Rehearse cutover in staging
**Labels:** `phase-4`, `database`, `runbook`
**Depends on:** P4.2, P4.3, P4.4
**Effort:** M

Full cutover in staging with synthetic traffic. Measure downtime. Rehearse rollback. Capture runbook deviations.

**Acceptance:**
- [ ] Cutover downtime <5 minutes
- [ ] Runbook exists and is PR-reviewed
- [ ] Rollback exercised successfully

#### P4.6 — Cutover runbook & maintenance window
**Labels:** `phase-4`, `database`, `runbook`, `critical`
**Depends on:** P4.5
**Effort:** S

Schedule maintenance window, comms drafted, go/no-go checklist, decision tree for common failures (lag, connectivity, auth). Runbook published to `/docs/operations/`.

**Acceptance:**
- [ ] Runbook approved by at least 2 reviewers
- [ ] Comms sent 7d / 24h / 1h before

#### P4.7 — Execute prod cutover
**Labels:** `phase-4`, `database`, `deploy`, `critical`
**Depends on:** P4.6
**Effort:** M (day-of)

Aurora → read-only → replication lag 0 → flip `DATABASE_URL` → app rolling restart → open writes.

**Acceptance:**
- [ ] App healthy post-cut
- [ ] Zero data loss (row count + PK spot-check)
- [ ] Writes flowing into Cloud SQL

#### P4.8 — pgvector re-index & ANALYZE
**Labels:** `phase-4`, `database`, `performance`
**Depends on:** P4.7
**Effort:** S

Rebuild IVFFlat index on `embeddings` table with same-as-prod parameters; run ANALYZE. Verify search latency within 10% of prior baseline.

**Acceptance:**
- [ ] p95 embedding search within 10% of baseline
- [ ] Query plan uses the new index

#### P4.9 — 14-day monitor + sign-off
**Labels:** `phase-4`, `database`, `monitor`
**Depends on:** P4.7
**Effort:** — (observational)

Track: failover events, p95 latency, replication lag (reverse, for potential rollback). At 14 days: sign off, stop Aurora writes permanently.

**Acceptance:**
- [ ] Sign-off comment from DBA / tech lead

#### P4.10 — Rip-out: remove Aurora connection code, keep snapshot
**Labels:** `phase-4`, `database`, `cleanup`
**Depends on:** P4.9
**Effort:** S

Delete `DATABASE_URL_SHADOW`, RDS Data API code paths. Aurora cluster kept cold until P7.

---

## Phase 5 — Compute + Edge

### Epic P5 — Traffic on Cloud Run, ECS decommissioned
**Labels:** `epic`, `phase-5`, `gcp-migration`, `compute`
**Exit criterion:** `aistudio.*` all three env domains resolve to Cloud Run with TLS; latency within 10% of baseline.
**Rollback:** DNS flip back to ALB (low-TTL pre-prepared).

#### P5.1 — Terraform `cloud-run` module (prod-grade)
**Labels:** `phase-5`, `compute`, `terraform`
**Depends on:** P0.3, P0.4
**Effort:** M

Hardened Cloud Run service: min-instances=1 prod / 0 dev, CPU boost, startup/liveness/readiness probes mapping to `/api/healthz` + `/api/health`, concurrency tuned, graceful shutdown via existing tini signal handling.

**Acceptance:**
- [ ] Module passes `terraform validate` + lint
- [ ] Dev deploy runs the real Next.js build, not the stub from P0.7

#### P5.2 — Global External HTTPS LB + Serverless NEG
**Labels:** `phase-5`, `compute`, `terraform`, `networking`
**Depends on:** P5.1
**Effort:** M

Global LB, managed TLS cert (Google-managed), URL map, Serverless NEG targeting Cloud Run per region.

**Acceptance:**
- [ ] HTTPS probe from external network returns 200
- [ ] Cert shows valid, Google-managed

#### P5.3 — Cloud CDN config
**Labels:** `phase-5`, `compute`, `terraform`
**Depends on:** P5.2
**Effort:** S

Enable on static-asset URL patterns only. Cache headers we set today on CloudFront migrate unchanged.

**Acceptance:**
- [ ] `_next/static/*` served with `x-cache: HIT` after warmup
- [ ] API paths never cached

#### P5.4 — Cloud DNS zones + low-TTL prep
**Labels:** `phase-5`, `compute`, `dns`
**Depends on:** —
**Effort:** S

Create zones in Cloud DNS matching production records. **Seven days before cutover:** drop TTL on prod records in Route 53 to 60s.

**Acceptance:**
- [ ] Zones exist, records match
- [ ] TTL drop scheduled and tracked

#### P5.5 — Blue/green deploy in CI
**Labels:** `phase-5`, `compute`, `ci`
**Depends on:** P5.1
**Effort:** M

Deploy new revision → route 10% → smoke → 50% → smoke → 100%. On probe failure: immediate 0%. Add deploy job to `deploy-gcp-prod` workflow (gated on approval).

**Acceptance:**
- [ ] Manual smoke + automated canary check
- [ ] Failed canary triggers rollback, alerts on-call

#### P5.6 — DNS cutover: dev → staging → prod
**Labels:** `phase-5`, `compute`, `dns`, `critical`
**Depends on:** P5.4, P5.5, P4.9 (prod only)
**Effort:** S per env

Flip A/AAAA to Cloud LB IPs. Watch for TLS, for referer issues, for webhook endpoints whose allow-lists need updating.

**Acceptance:**
- [ ] All env URLs resolve to GCP
- [ ] Cert valid in all browsers
- [ ] No 4xx/5xx spike beyond baseline

#### P5.7 — Rip-out: FrontendStack-ECS, CloudFront, ECR
**Labels:** `phase-5`, `compute`, `cleanup`
**Depends on:** P5.6 (+14 day stable window)
**Effort:** M

`cdk destroy FrontendStack-ECS-Prod` etc. Delete CloudFront distributions (keep DNS pointer dead for 30 days in case). Delete ECR repos.

**Acceptance:**
- [ ] ECS services have task-count 0 and stay there
- [ ] CloudFront distributions disabled
- [ ] No AWS dashboard widget in on-call runbook still live

---

## Phase 6 — Secrets + Observability (parallel with P3–P5)

### Epic P6 — Secrets in Secret Manager, observability in Cloud ops
**Labels:** `epic`, `phase-6`, `gcp-migration`, `ops`
**Exit criterion:** all critical alerts fire identically from Cloud Monitoring for 7 days; on-call drill passes.
**Rollback:** dual-publish stays on; CloudWatch remains source of truth until drill passes.

#### P6.1 — Inventory & rotate secrets into Secret Manager
**Labels:** `phase-6`, `secrets`, `security`
**Depends on:** —
**Effort:** M

Walk the CDK `SecretsStack` + AWS Secrets Manager console. Each secret: create a new Secret Manager secret with a **new value**, add to `sa-factory` inputs for the consuming workload, update app config to read from it.

**Acceptance:**
- [ ] Inventory committed: `{aws_secret_arn, gcp_secret_name, consumer_workload}` for each
- [ ] Rotation complete in all envs
- [ ] No code still reads from AWS Secrets Manager

#### P6.2 — `@/lib/settings-manager` GCP Secret Manager backend
**Labels:** `phase-6`, `secrets`, `app`
**Depends on:** P6.1
**Effort:** S

Add `SECRETS_PROVIDER=gcp-secret-manager` path alongside existing AWS path. Cache TTL unchanged (5 min).

**Acceptance:**
- [ ] Unit tests green against both backends
- [ ] Local dev uses `.env.local` as before

#### P6.3 — Cloud Logging sink + log-based metrics
**Labels:** `phase-6`, `observability`, `terraform`
**Depends on:** P5.1
**Effort:** M

Default sink for Cloud Run logs. Log-based metrics replace the current CloudWatch custom metrics emitted from `@/lib/logger`. Names stable across the transition.

**Acceptance:**
- [ ] Metrics visible in Cloud Monitoring with identical names
- [ ] 7-day retention in dev, 30-day prod

#### P6.4 — Cloud Monitoring dashboard parity
**Labels:** `phase-6`, `observability`, `terraform`
**Depends on:** P6.3
**Effort:** L

Recreate the "AIStudio-Consolidated-[Env]" CloudWatch dashboard as a Cloud Monitoring dashboard. 115+ widgets. Sub-tasks per section: Lambda (→ Cloud Run Jobs), ECS (→ Cloud Run), RDS (→ Cloud SQL), API latency.

**Acceptance:**
- [ ] Dashboard terraformed and version-controlled
- [ ] On-call can find every metric that exists on the AWS dashboard

#### P6.5 — Alert policy migration (per-alarm sub-tasks)
**Labels:** `phase-6`, `observability`, `terraform`, `alerting`
**Depends on:** P6.4
**Effort:** L

Each CloudWatch alarm becomes a Cloud Monitoring alerting policy. Composite alarms may not translate 1:1 — document exceptions inline. Route to existing PagerDuty.

**Acceptance:**
- [ ] Alert-for-alert parity spreadsheet, with `{cloudwatch_arn, cloud_monitoring_id, notes}`
- [ ] PagerDuty integration tested with a forced alert

#### P6.6 — OTel collector sidecar replaces ADOT
**Labels:** `phase-6`, `observability`, `app`
**Depends on:** P5.1
**Effort:** M

Cloud Run sidecar runs an OTel collector shipping to Cloud Trace. App instrumentation unchanged (`@aws-lambda-powertools/metrics` and friends are wrapped in our own `@/lib/logger` so the transport swap is contained).

**Acceptance:**
- [ ] Traces visible in Cloud Trace for a sample chat request
- [ ] No additional request latency

#### P6.7 — On-call drill
**Labels:** `phase-6`, `observability`, `ops`
**Depends on:** P6.4, P6.5
**Effort:** S

Scripted incident: force alerts, validate pager fires, validate runbooks link to the right Cloud Monitoring dashboards.

**Acceptance:**
- [ ] Drill report with any gaps addressed or tracked

#### P6.8 — Rip-out: remove CloudWatch publisher, ADOT, SecretsManager client
**Labels:** `phase-6`, `observability`, `cleanup`
**Depends on:** P6.7
**Effort:** S

Delete `lib/metrics/cloudwatch-publisher.ts`, ADOT layer references, `@aws-sdk/client-secrets-manager`. Drop `MonitoringStack` and `SecretsStack` in CDK.

**Acceptance:**
- [ ] No AWS observability code paths remain
- [ ] `bun run lint && bun run typecheck` green

---

## Phase 7 — Email + teardown

### Epic P7 — AWS account contains only cold archival; repo is AWS-clean
**Labels:** `epic`, `phase-7`, `gcp-migration`, `cleanup`
**Exit criterion:** `grep -r aws- lib/ app/ infra-gcp/ package.json` returns empty; no AWS CI secrets; only cold archive buckets remain in AWS, if any.

#### P7.1 — Email provider spike → ADR-008
**Labels:** `phase-7`, `email`, `spike`
**Depends on:** —
**Effort:** M

Spike: SendGrid vs Postmark vs keep SES cross-cloud. Evaluate on deliverability, tenant-billing convenience, template system. Output: ADR-008.

**Acceptance:**
- [ ] ADR-008 merged
- [ ] Decision captures rationale per criterion

#### P7.2 — Implement chosen email provider
**Labels:** `phase-7`, `email`, `app`
**Depends on:** P7.1
**Effort:** M

Adapter in `lib/email/` parallel to the pattern from other workstreams. Staging first, then prod.

**Acceptance:**
- [ ] All transactional email paths routed through new provider
- [ ] Bounce/complaint webhook working

#### P7.3 — Export Cognito user manifest; delete user pool
**Labels:** `phase-7`, `teardown`, `auth`
**Depends on:** P1.6 (+30 days stable)
**Effort:** S

Export CSV for compliance archive. Delete pool.

**Acceptance:**
- [ ] Manifest archived per retention policy
- [ ] Pool deleted

#### P7.4 — Aurora final snapshot + delete
**Labels:** `phase-7`, `teardown`, `database`
**Depends on:** P4.9 (+30 days stable)
**Effort:** S

Final manual snapshot. Delete cluster.

**Acceptance:**
- [ ] Snapshot retained per legal/compliance policy
- [ ] Cluster deleted

#### P7.5 — S3 lifecycle → Glacier → delete
**Labels:** `phase-7`, `teardown`, `storage`
**Depends on:** P3.6 (+90 days stable)
**Effort:** S

Transition remaining objects to archive class. After 90d: delete buckets.

**Acceptance:**
- [ ] Buckets empty
- [ ] Buckets deleted

#### P7.6 — `cdk destroy --all` per env
**Labels:** `phase-7`, `teardown`, `terraform`
**Depends on:** P6.8
**Effort:** M

Systematically destroy remaining CDK stacks in all envs. Order matters — run destroy in reverse dependency order.

**Acceptance:**
- [ ] `cdk ls` empty in all envs
- [ ] `/infra/` deleted from repo on the completion commit

#### P7.7 — Residual IAM / KMS / log-group cleanup
**Labels:** `phase-7`, `teardown`, `security`
**Depends on:** P7.6
**Effort:** S

Sweep the AWS Config / IAM console for orphaned roles, KMS keys, log groups. Delete or schedule for deletion.

**Acceptance:**
- [ ] Cleanup report committed to the issue

#### P7.8 — `package.json` AWS dependency purge
**Labels:** `phase-7`, `teardown`, `app`, `cleanup`
**Depends on:** P6.8, P7.6
**Effort:** S

Remove: `@aws-sdk/*`, `aws-cdk-lib`, `aws-jwt-verify`, any remaining AWS-specific deps. `bun install` + full lint + typecheck + test.

**Acceptance:**
- [ ] `grep -r @aws-sdk package.json` returns empty
- [ ] CI green

#### P7.9 — Final verification + closeout
**Labels:** `phase-7`, `teardown`, `ops`
**Depends on:** P7.2–P7.8
**Effort:** S

Final grep-based sweep; cost-delta report (GCP monthly vs AWS monthly baseline); retrospective; archive ADR-007 as implemented.

**Acceptance:**
- [ ] Repo-wide grep for `aws`, `s3`, `cognito`, `bedrock`, `cloudwatch`, `cloudfront`, `aurora`, `ecs` confirms only docs/ references remain
- [ ] Cost-delta slide shared with stakeholders
- [ ] ADR-007 status moved to `Accepted (Completed)`

---

## Cross-cutting issues (not phase-specific)

### X.1 — Runbook authorship standard
**Labels:** `cross-cutting`, `docs`
**Effort:** XS

Agree on a runbook template (steps, rollback, observability links) before P4. All phase runbooks conform.

### X.2 — Communication plan (users + org)
**Labels:** `cross-cutting`, `comms`
**Effort:** S per phase

Pre-written templates for auth cutover (P1), maintenance windows (P4, P5), any perceivable change.

### X.3 — Budget tracking dashboard
**Labels:** `cross-cutting`, `finance`
**Effort:** M

Combined AWS + GCP spend dashboard for the overlap period. Flag if total spend >1.7× current baseline.

### X.4 — Security review per phase-exit
**Labels:** `cross-cutting`, `security`
**Effort:** S per phase

Short security review gate before each phase exits. Uses the `/security-review` workflow.

---

## Priority summary

| Phase | Parallel-safe? | First prod impact | Rollback complexity |
|---|---|---|---|
| P0 | Yes | None | Trivial |
| P1 | Yes | Medium (sign-in UX) | Low |
| P2 | Yes | Medium (chat behavior) | Low |
| P3 | Yes | Low | Low |
| P4 | **No — single critical window** | **High** | **High post-cut** |
| P5 | Yes (DNS flip is reversible) | Medium | Low |
| P6 | Yes — runs parallel to P3–P5 | None | Low |
| P7 | Yes | None (by design) | N/A — teardown only |

---

*Work breakdown written alongside [ADR-007](../architecture/adr/ADR-007-gcp-migration.md). Expected to evolve as phases complete; not all tickets are known on day one.*
