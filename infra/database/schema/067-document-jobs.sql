-- Migration 067: document_jobs table for async document processing pipeline (SSD201 GCP fork)
--
-- Replaces the prior DynamoDB-backed lib/services/document-job-service.ts which was
-- broken behind @ts-nocheck (DynamoDBClientStub silently no-op'd; references to
-- undefined S3Client/AttributeValue would throw at runtime). Per the GCP migration
-- plan (docs/plans/2026-04-21-gcs-object-storage-slice.md, slice E) job tracking
-- moves to the existing AlloyDB instance rather than introducing Firestore — keeps
-- the surface area small (one fewer GCP service, one fewer SDK, reuse Drizzle/migration
-- patterns) and the workload (one row per upload, low write rate) is well within
-- Postgres capacity for SSD201 scale.
--
-- Columns mirror the previous DocumentJob TypeScript interface; field-name change:
--   resultS3Key   -> result_gcs_key      (storage backend changed)
--   resultLocation values 's3'/'dynamodb' -> 'gcs'/'inline'

CREATE TABLE IF NOT EXISTS document_jobs (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- OIDC subject (session.sub), NOT a FK to users.id — the existing service stored
  -- subject identifiers and callers pass session.sub. Keeping the same shape avoids
  -- a sub->users.id lookup at every call site. Document jobs are short-lived (7-day
  -- TTL in the original; we'll honor that via a periodic cleanup job, not RI).
  --
  -- Data-retention note: because there's no FK, user-deletion (GDPR / "delete my
  -- data") will NOT cascade to this table. deleteOldJobs only sweeps TERMINAL
  -- statuses, so a user deleted while a job is pending/processing leaves the row
  -- pointing at their orphaned `sub` indefinitely. The user-deletion path
  -- (see migration 041 cascade work) needs a separate sweep against this table.
  user_id             VARCHAR(255) NOT NULL,

  file_name           TEXT         NOT NULL,
  file_size           BIGINT       NOT NULL,
  file_type           VARCHAR(255) NOT NULL,

  purpose             VARCHAR(50)  NOT NULL
    CHECK (purpose IN ('chat', 'repository', 'assistant')),

  -- ProcessingOptions: extractText, convertToMarkdown, extractImages,
  -- generateEmbeddings, ocrEnabled. JSONB so future options don't require
  -- migrations. No DEFAULT — the TS type declares 5 required booleans, so a
  -- '{}'::jsonb default would silently violate the contract; callers always
  -- supply the object.
  processing_options  JSONB        NOT NULL,

  status              VARCHAR(50)  NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

  progress            INTEGER,
  processing_stage    VARCHAR(255),

  -- Results: either inline (small, fits in JSONB) or in object storage.
  -- result_location distinguishes the two; the invariant that the right
  -- companion column is populated for each location is enforced by the
  -- result_location_consistency CHECK constraint below.
  result              JSONB,
  result_location     VARCHAR(50)
    CHECK (result_location IS NULL OR result_location IN ('inline', 'gcs')),
  -- 1024 matches the GCS object-name length limit (per
  -- https://cloud.google.com/storage/docs/objects#naming) — picks the
  -- ceiling rather than something tighter, since PR B's file-processor
  -- may compose paths from job IDs + user-controlled fragments.
  result_gcs_key      VARCHAR(1024),

  error_message       TEXT,

  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW(),

  -- Tie result_location to its companion column. Without this, the
  -- file-processor (PR B) could silently set result_location='gcs' but forget
  -- to write result_gcs_key, and the read path would 404 every fetch.
  CONSTRAINT result_location_consistency CHECK (
    result_location IS NULL
    OR (result_location = 'inline' AND result IS NOT NULL)
    OR (result_location = 'gcs'    AND result_gcs_key IS NOT NULL)
  )
);

-- Per-user listing (UI shows recent uploads), newest first.
CREATE INDEX IF NOT EXISTS document_jobs_user_id_created_at_idx
  ON document_jobs (user_id, created_at DESC);

-- Status sweeps (cleanup job, monitoring of stuck-in-processing rows).
CREATE INDEX IF NOT EXISTS document_jobs_status_created_at_idx
  ON document_jobs (status, created_at DESC);

-- updated_at trigger — required per CLAUDE.md "don't create tables with updated_at
-- without the PostgreSQL trigger" (silent-failure pattern).
-- Reuses the project-standard update_updated_at_column() function created in
-- migration 017 (also referenced by migration 028 for nexus tables).
DROP TRIGGER IF EXISTS update_document_jobs_updated_at ON document_jobs;
CREATE TRIGGER update_document_jobs_updated_at
  BEFORE UPDATE ON document_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
