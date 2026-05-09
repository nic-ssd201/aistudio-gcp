/**
 * Document job service — Postgres-backed (AlloyDB).
 *
 * Replaces the prior DynamoDB-backed implementation that was broken behind
 * @ts-nocheck (DynamoDBClientStub silently no-op'd; references to undefined
 * S3Client / AttributeValue would throw at runtime). The migration plan
 * (docs/plans/2026-04-21-gcs-object-storage-slice.md) called for Firestore
 * as the natural DynamoDB replacement; we deliberately deviate to Postgres
 * for SSD201 — one fewer GCP service / SDK to manage, the workload is well
 * within Postgres capacity, and we get to reuse the existing Drizzle/migration
 * patterns and test infrastructure.
 *
Public API kept stable for callers in app/api/documents/v2/* with three rename-shaped changes:
 *   resultS3Key            -> resultGcsKey
 *   resultLocation: 's3'   -> 'gcs'        (and 'dynamodb' -> 'inline')
 *   fetchResultFromS3      -> fetchResultFromGcs
 * The route caller is updated in this same PR; no deprecation alias is kept.
 */

import { eq, and, desc, lt, inArray, sql } from "drizzle-orm"
import { executeQuery } from "@/lib/db/drizzle-client"
import {
  documentJobs,
  type DocumentJobProcessingOptions,
  type DocumentJobResult,
} from "@/lib/db/schema"
import { getObjectStream } from "@/lib/services/document-storage-service"
import { createLogger, generateRequestId } from "@/lib/logger"

// ============================================
// Types — public surface
// ============================================

export type ProcessingOptions = DocumentJobProcessingOptions

export interface DocumentJob {
  id: string
  userId: string
  fileName: string
  fileSize: number
  fileType: string
  purpose: "chat" | "repository" | "assistant"
  processingOptions: ProcessingOptions
  status: "pending" | "processing" | "completed" | "failed"
  progress?: number
  processingStage?: string
  result?: DocumentJobResult
  resultLocation?: "inline" | "gcs"
  resultGcsKey?: string
  errorMessage?: string
  createdAt: string
  completedAt?: string
}

export interface CreateJobParams {
  fileName: string
  fileSize: number
  fileType: string
  purpose: "chat" | "repository" | "assistant"
  userId: string
  processingOptions: ProcessingOptions
}

/** Cursor for keyset pagination on (created_at DESC, id DESC). */
export interface JobsCursor {
  createdAt: string
  id: string
}

// ============================================
// Mapping
// ============================================

type Row = typeof documentJobs.$inferSelect

function toDocumentJob(row: Row): DocumentJob {
  return {
    id: row.id,
    userId: row.userId,
    fileName: row.fileName,
    fileSize: row.fileSize,
    fileType: row.fileType,
    purpose: row.purpose,
    processingOptions: row.processingOptions,
    status: row.status,
    progress: row.progress ?? undefined,
    processingStage: row.processingStage ?? undefined,
    result: row.result ?? undefined,
    resultLocation: row.resultLocation ?? undefined,
    resultGcsKey: row.resultGcsKey ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  }
}

// ============================================
// CRUD
// ============================================

export async function createDocumentJob(params: CreateJobParams): Promise<DocumentJob> {
  const requestId = generateRequestId()
  const log = createLogger({ action: "createDocumentJob", requestId })

  log.info("Creating document job", {
    fileSize: params.fileSize,
    fileType: params.fileType,
    purpose: params.purpose,
    fileName:
      params.fileName.length > 50
        ? params.fileName.substring(0, 50) + "..."
        : params.fileName,
    userId: params.userId.substring(0, 8) + "...",
  })

  const [row] = await executeQuery(
    (db) =>
      db
        .insert(documentJobs)
        .values({
          userId: params.userId,
          fileName: params.fileName,
          fileSize: params.fileSize,
          fileType: params.fileType,
          purpose: params.purpose,
          processingOptions: params.processingOptions,
          status: "pending",
        })
        .returning(),
    "createDocumentJob",
  )

  if (!row) {
    log.error("Insert returned no row")
    throw new Error("Failed to create document job: no row returned")
  }

  log.info("Document job created", { jobId: row.id })
  return toDocumentJob(row)
}

/**
 * Fetch a single job WITH ownership scoping. Use this from any request-scoped
 * code path — it's the auth-safe default. Returns null if the job either
 * doesn't exist or belongs to another user (the caller can't distinguish,
 * which is by design — don't leak existence of jobs across users).
 */
export async function getJobForUser(
  userId: string,
  jobId: string,
): Promise<DocumentJob | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(documentJobs)
        .where(and(eq(documentJobs.id, jobId), eq(documentJobs.userId, userId)))
        .limit(1),
    "getJobForUser",
  )
  return rows[0] ? toDocumentJob(rows[0]) : null
}

/**
 * Fetch a single job WITHOUT ownership scoping. Internal/trusted callers only
 * (file-processor reading the row it's about to update, scheduled cleanup
 * sweeps, admin tooling). NEVER call this from a request-scoped path —
 * a stolen jobId would let any authenticated user read the row. Use
 * `getJobForUser(userId, jobId)` from any user-facing route.
 *
 * The "Unscoped" suffix is deliberate: the name is meant to scream at
 * code review. If you're tempted to use this from a route handler, stop.
 */
export async function getJobStatusUnscoped(
  jobId: string,
): Promise<DocumentJob | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(documentJobs)
        .where(eq(documentJobs.id, jobId))
        .limit(1),
    "getJobStatusUnscoped",
  )
  return rows[0] ? toDocumentJob(rows[0]) : null
}

/**
 * Update a job's status plus any subset of progress/stage/result/error.
 * `completed_at` is auto-set when transitioning to `completed` unless the
 * caller passes it explicitly. The `updated_at` column is maintained by the
 * `update_document_jobs_updated_at` trigger (see migration 067).
 *
 * **Authorization:** this function does NOT check ownership — the WHERE matches
 * solely on jobId. Callers MUST verify `job.userId === session.sub` first
 * (typically via `getJobForUser(session.sub, jobId)`) before invoking this from
 * a request-scoped path. Trusted internal callers (file-processor, scheduled
 * cleanup) are exempt.
 */
export async function updateJobStatus(
  jobId: string,
  status: DocumentJob["status"],
  updates: Partial<
    Pick<
      DocumentJob,
      | "progress"
      | "processingStage"
      | "result"
      | "resultLocation"
      | "resultGcsKey"
      | "errorMessage"
      | "completedAt"
    >
  > = {},
): Promise<void> {
  const log = createLogger({ action: "updateJobStatus" })

  // Build a partial values object so we never write `undefined` (which Drizzle
  // would otherwise treat as a SQL NULL, clobbering existing values per the
  // CLAUDE.md silent-failure note).
  const values: Partial<typeof documentJobs.$inferInsert> = { status }
  if (updates.progress !== undefined) values.progress = updates.progress
  if (updates.processingStage !== undefined) values.processingStage = updates.processingStage
  if (updates.result !== undefined) values.result = updates.result
  if (updates.resultLocation !== undefined) values.resultLocation = updates.resultLocation
  if (updates.resultGcsKey !== undefined) values.resultGcsKey = updates.resultGcsKey
  if (updates.errorMessage !== undefined) values.errorMessage = updates.errorMessage
  if (updates.completedAt !== undefined) {
    values.completedAt = new Date(updates.completedAt)
  } else if (status === "completed") {
    values.completedAt = new Date()
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(documentJobs)
        .set(values)
        .where(eq(documentJobs.id, jobId))
        .returning({ id: documentJobs.id }),
    "updateJobStatus",
  )

  if (result.length === 0) {
    log.error("Job not found", { jobId, status })
    throw new Error(`Job not found: ${jobId}`)
  }

  log.info("Job status updated", { jobId, status })
}

/**
 * Mark a job as upload-confirmed (status -> 'processing'). Idempotent and
 * monotone: only fires when the row is currently 'pending', so retrying
 * confirm-upload after the file-processor has already moved the job to
 * 'failed' or 'completed' won't silently rewind it back to 'processing'.
 *
 * Returns whether the transition actually happened (useful for callers that
 * want to react differently to an idempotent retry vs. a first-time confirm).
 */
export async function confirmDocumentUpload(
  jobId: string,
  uploadId: string,
): Promise<boolean> {
  const log = createLogger({ action: "confirmDocumentUpload" })

  const transitioned = await executeQuery(
    (db) =>
      db
        .update(documentJobs)
        .set({
          status: "processing",
          processingStage: "upload_confirmed",
          progress: 10,
        })
        .where(
          and(eq(documentJobs.id, jobId), eq(documentJobs.status, "pending")),
        )
        .returning({ id: documentJobs.id }),
    "confirmDocumentUpload",
  )

  if (transitioned.length === 0) {
    log.info("confirmDocumentUpload no-op (job not in 'pending' state)", {
      jobId,
      uploadId,
    })
    return false
  }
  log.info("Document upload confirmed", { jobId, uploadId })
  return true
}

/**
 * List a user's recent jobs, newest first, keyset-paginated on
 * (created_at DESC, id DESC). Pass `cursor` (the `nextCursor` from a prior
 * call) to fetch the next page.
 *
 * Note: replaces the prior DynamoDB `lastEvaluatedKey` opaque-blob shape with
 * an explicit cursor type; callers using the field need a small update.
 */
export async function getUserJobs(
  userId: string,
  limit = 20,
  cursor?: JobsCursor,
): Promise<{ jobs: DocumentJob[]; nextCursor?: JobsCursor }> {
  const conditions = [eq(documentJobs.userId, userId)]
  if (cursor) {
    // (created_at, id) < (cursor.createdAt, cursor.id) under DESC ordering.
    conditions.push(
      sql`(${documentJobs.createdAt}, ${documentJobs.id}) < (${new Date(cursor.createdAt)}, ${cursor.id})`,
    )
  }

  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(documentJobs)
        .where(and(...conditions))
        .orderBy(desc(documentJobs.createdAt), desc(documentJobs.id))
        .limit(limit + 1),
    "getUserJobs",
  )

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    jobs: page.map(toDocumentJob),
    nextCursor: hasMore && last
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : undefined,
  }
}

/** Hard ceiling on cross-user listings — clamps the requested limit so a
 *  buggy admin caller can't ask for hundreds of thousands of rows. */
const MAX_BULK_LIMIT = 500

/**
 * List jobs by status across ALL users. Intended for administrative use
 * (cleanup sweeps, monitoring stuck-in-processing rows). Do NOT expose
 * directly from a user-facing route — there is no userId scoping.
 */
export async function getJobsByStatus(
  status: DocumentJob["status"],
  limit = 50,
): Promise<DocumentJob[]> {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_BULK_LIMIT)
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(documentJobs)
        .where(eq(documentJobs.status, status))
        .orderBy(desc(documentJobs.createdAt))
        .limit(safeLimit),
    "getJobsByStatus",
  )
  return rows.map(toDocumentJob)
}

/**
 * Delete TERMINAL jobs older than `olderThanDays`. Replaces the prior
 * DynamoDB TTL behavior. Returns the number of rows deleted.
 *
 * Status filter is intentional: a `pending` or `processing` row created >7 days
 * ago is most likely stuck (consumer outage, paused queue) and silently
 * deleting it would compound the failure. Operators should investigate
 * stuck rows directly via getJobsByStatus rather than relying on TTL.
 */
export async function deleteOldJobs(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
  const deleted = await executeQuery(
    (db) =>
      db
        .delete(documentJobs)
        .where(
          and(
            lt(documentJobs.createdAt, cutoff),
            inArray(documentJobs.status, ["completed", "failed"]),
          ),
        )
        .returning({ id: documentJobs.id }),
    "deleteOldJobs",
  )
  return deleted.length
}

// ============================================
// Result fetcher (large results stored in GCS)
// ============================================

/**
 * Fetch a JSON result blob that the file-processor wrote to GCS for a given
 * job. Used when `result_location === 'gcs'` (large extraction outputs that
 * exceed the inline JSONB threshold).
 */
export async function fetchResultFromGcs(
  gcsKey: string,
): Promise<DocumentJobResult> {
  const log = createLogger({ action: "fetchResultFromGcs" })

  try {
    const { stream } = await getObjectStream(gcsKey)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks).toString("utf8")
    return JSON.parse(body) as DocumentJobResult
  } catch (error) {
    log.error("Failed to fetch result from GCS", {
      gcsKey,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(
      `Failed to fetch result from GCS: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}

