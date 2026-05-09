/**
 * Inline-vs-GCS result storage decision for the document-processor.
 *
 * Small results (< INLINE_RESULT_MAX_BYTES, default 400 KB to match the prior
 * DynamoDB threshold) are written to the `result` JSONB column. Larger results
 * are written to GCS and only the key is stored in `result_gcs_key`. The
 * migration's `result_location_consistency` CHECK constraint enforces the
 * invariant that the right companion column is populated for each location.
 *
 * 400 KB is a deliberate floor: small enough that JSONB row scans aren't
 * pathological, large enough to keep the typical extraction (a few thousand
 * tokens of plain text + light metadata) inline.
 */

import { uploadDocumentAtKey } from "@/lib/gcp/gcs-client"
import { createLogger } from "@/lib/logger"

const log = createLogger({ service: "document-processor.result-storage" })

const DEFAULT_INLINE_LIMIT_BYTES = 400 * 1024 // 400 KB

function getInlineLimitBytes(): number {
  const raw = process.env.INLINE_RESULT_MAX_BYTES
  if (!raw) return DEFAULT_INLINE_LIMIT_BYTES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn(
      "INLINE_RESULT_MAX_BYTES is not a positive integer; using default",
      { raw, defaultBytes: DEFAULT_INLINE_LIMIT_BYTES },
    )
    return DEFAULT_INLINE_LIMIT_BYTES
  }
  return parsed
}

export interface ResultLocation {
  resultLocation: "inline" | "gcs"
  result?: Record<string, unknown>
  resultGcsKey?: string
}

/**
 * Decide where to store the extracted result and return the columns the
 * caller should pass to updateJobStatus. The GCS path is keyed by jobId
 * (path: v2/results/<jobId>/result.json) so it's deterministic and tied to
 * the job's lifetime.
 */
export async function persistResult(
  jobId: string,
  result: Record<string, unknown>,
): Promise<ResultLocation> {
  const limit = getInlineLimitBytes()
  const json = JSON.stringify(result)
  const sizeBytes = Buffer.byteLength(json, "utf8")

  if (sizeBytes <= limit) {
    return { resultLocation: "inline", result }
  }

  // Deterministic key — re-processing the same job overwrites the prior blob,
  // so a job that flips between completed and failed (e.g. operator re-run
  // after a model fix) doesn't leave orphaned bytes around.
  const key = `v2/results/${jobId}/result.json`
  await uploadDocumentAtKey({
    key,
    fileBuffer: Buffer.from(json, "utf8"),
    contentType: "application/json",
    metadata: { jobId, sizeBytes: String(sizeBytes) },
  })
  log.info("Stored large result in GCS", { jobId, sizeBytes, key })
  return { resultLocation: "gcs", resultGcsKey: key }
}
