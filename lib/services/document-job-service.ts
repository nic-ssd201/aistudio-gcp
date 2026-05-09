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
 * Public API kept stable for callers in app/api/documents/v2/*. Two field-level
 * changes carried through to the DocumentJob type:
 *   resultS3Key           -> resultGcsKey
 *   resultLocation: 's3'  -> 'gcs'        (and 'dynamodb' -> 'inline')
 *
 * `fetchResultFromS3` is renamed to `fetchResultFromGcs` (the old name is
 * kept as a deprecated alias so the route caller can migrate in a separate
 * patch). Both pull from GCS via the existing gcs-client.
 */

import { eq, and, desc, lt, sql } from "drizzle-orm"
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
    resultLocation: (row.resultLocation as "inline" | "gcs" | null) ?? undefined,
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
 * Fetch a single job. When `userId` is supplied, an ownership filter is added
 * so a stolen jobId can't be used to read another user's row.
 */
export async function getJobStatus(
  jobId: string,
  userId?: string,
): Promise<DocumentJob | null> {
  const where = userId
    ? and(eq(documentJobs.id, jobId), eq(documentJobs.userId, userId))
    : eq(documentJobs.id, jobId)

  const rows = await executeQuery(
    (db) => db.select().from(documentJobs).where(where).limit(1),
    "getJobStatus",
  )

  return rows[0] ? toDocumentJob(rows[0]) : null
}

/**
 * Update a job's status plus any subset of progress/stage/result/error.
 * `completed_at` is auto-set when transitioning to `completed` unless the
 * caller passes it explicitly. The `updated_at` column is maintained by the
 * `update_document_jobs_updated_at` trigger (see migration 067).
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

export async function confirmDocumentUpload(
  jobId: string,
  uploadId: string,
): Promise<void> {
  const log = createLogger({ action: "confirmDocumentUpload" })
  await updateJobStatus(jobId, "processing", {
    processingStage: "upload_confirmed",
    progress: 10,
  })
  log.info("Document upload confirmed", { jobId, uploadId })
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

export async function getJobsByStatus(
  status: DocumentJob["status"],
  limit = 50,
): Promise<DocumentJob[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(documentJobs)
        .where(eq(documentJobs.status, status))
        .orderBy(desc(documentJobs.createdAt))
        .limit(limit),
    "getJobsByStatus",
  )
  return rows.map(toDocumentJob)
}

/**
 * Delete jobs older than `olderThanDays`. Used by the cleanup job that replaces
 * the prior DynamoDB TTL behavior. Returns the number of rows deleted.
 */
export async function deleteOldJobs(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
  const deleted = await executeQuery(
    (db) =>
      db
        .delete(documentJobs)
        .where(lt(documentJobs.createdAt, cutoff))
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

/**
 * @deprecated Use `fetchResultFromGcs`. Preserved temporarily so the
 * /api/documents/v2/jobs/[jobId] route can migrate in a separate patch.
 */
export const fetchResultFromS3 = fetchResultFromGcs
