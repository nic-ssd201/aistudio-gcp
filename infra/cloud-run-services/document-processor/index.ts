/**
 * document-processor — Cloud Run Service entrypoint.
 *
 * Three HTTP routes:
 *   GET  /healthz             Liveness probe; no auth.
 *   POST /process-job         Cloud Tasks dispatch. Verifies the inbound OIDC
 *                             token, fetches the GCS object for the job,
 *                             extracts text via lib/document-processing,
 *                             persists the result (inline or GCS depending
 *                             on size), and updates the job row.
 *   POST /admin/cleanup-jobs  Cloud Scheduler dispatch. Verifies a separate
 *                             scheduler-SA OIDC token and calls
 *                             deleteOldJobs to sweep terminal-status rows
 *                             older than the configured retention window.
 *
 * Failure mode: any error in /process-job is caught, logged, and written
 * back to the job row as `status='failed'` + errorMessage. The HTTP
 * response is still 200 in this case — Cloud Tasks should NOT retry on
 * extraction failures (they're deterministic and would just re-fail).
 * 5xx responses are reserved for transport-level failures (DB unreachable,
 * GCS unreachable) where Cloud Tasks' built-in backoff is the right thing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  getJobStatusUnscoped,
  updateJobStatus,
  deleteOldJobs,
  type DocumentJob,
} from "@/lib/services/document-job-service"
import { getObjectStream } from "@/lib/services/document-storage-service"
import { getUploadGcsKey } from "@/lib/gcp/gcs-client"
import {
  extractTextFromDocument,
  chunkText,
  getFileTypeFromFileName,
} from "@/lib/document-processing"
import { createLogger, generateRequestId } from "@/lib/logger"
import { verifyOidcToken } from "./oidc-verifier"
import { persistResult } from "./result-storage"

const log = createLogger({ service: "document-processor" })

// ============================================================================
// Env wiring
// ============================================================================

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} environment variable is required`)
  return v
}

// Required env vars set per-deploy:
// PROCESSOR_INVOKER_SA     SA email Cloud Tasks signs as (we pin the email claim)
// CLEANUP_INVOKER_SA       SA email Cloud Scheduler signs as
//
// The OIDC `aud` claim is derived from each inbound request's Host + URL
// rather than a deploy-time env var. Two reasons:
//   1. Pinning audience at deploy would create a Terraform cycle (the worker
//      module's env block would reference its own service_url output).
//   2. With INGRESS_TRAFFIC_INTERNAL_ONLY (cloud-run-worker module default),
//      the request Host header is trustworthy — only Google services + VPC
//      peers can reach the service, and Cloud Tasks always sends the host
//      it dispatched to. An attacker outside the VPC can't probe the
//      service in the first place. The IAM grant on the worker (only
//      sa_doc_proc / sa_scheduler hold roles/run.invoker) is the
//      defense-in-depth backstop.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10)

/**
 * Derive the expected OIDC audience for a given request from its own
 * authority and path. Trustworthy under INTERNAL_ONLY ingress; see the
 * comment block above for the threat-model argument.
 */
function expectedAudienceFor(req: IncomingMessage): string {
  const host = req.headers.host ?? "unknown-host"
  const path = req.url ?? ""
  return `https://${host}${path}`
}

// ============================================================================
// HTTP plumbing
// ============================================================================

// Cloud Tasks payloads are platform-capped at 100 KiB; 1 MiB here gives
// generous headroom for future multi-jobId batches without letting a
// misbehaving caller stream unbounded data into the worker's memory.
const MAX_BODY_BYTES = 1024 * 1024

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buf)
  }
  if (chunks.length === 0) return {} as T
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

// ============================================================================
// Route handlers
// ============================================================================

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { status: "ok" })
}

interface ProcessJobBody {
  message: {
    jobId: string
    bucket?: string
    key?: string
    fileName?: string
    fileType?: string
    userId?: string
  }
}

async function handleProcessJob(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = generateRequestId()
  const reqLog = createLogger({ requestId, route: "process-job" })

  // 1. Verify OIDC. Cloud Tasks signs with PROCESSOR_INVOKER_SA; audience
  //    is derived from the inbound request itself (see expectedAudienceFor).
  try {
    await verifyOidcToken(req.headers.authorization, {
      audience: expectedAudienceFor(req),
      expectedEmail: requiredEnv("PROCESSOR_INVOKER_SA"),
    })
  } catch (e) {
    reqLog.warn("OIDC verification failed", {
      reason: e instanceof Error ? e.message : String(e),
    })
    sendJson(res, 401, { error: "Unauthorized" })
    return
  }

  // 2. Parse body. The Cloud Tasks payload is `{ message: { jobId, ... } }`.
  let body: ProcessJobBody
  try {
    body = await readJsonBody<ProcessJobBody>(req)
  } catch (e) {
    reqLog.warn("Bad JSON body", { error: e instanceof Error ? e.message : String(e) })
    sendJson(res, 400, { error: "Invalid JSON body" })
    return
  }

  const jobId = body?.message?.jobId
  if (typeof jobId !== "string" || jobId.length === 0) {
    sendJson(res, 400, { error: "Missing message.jobId" })
    return
  }

  // 3. Look up the job row. We use the unscoped read because this is an
  //    internal trusted caller (the OIDC check above is the auth boundary).
  let job: DocumentJob | null
  try {
    job = await getJobStatusUnscoped(jobId)
  } catch (e) {
    // DB unreachable — return 5xx so Cloud Tasks retries with backoff.
    reqLog.error("Failed to read job row", {
      jobId,
      error: e instanceof Error ? e.message : String(e),
    })
    sendJson(res, 503, { error: "DB unavailable" })
    return
  }

  if (!job) {
    // Idempotent no-op: the job was deleted between enqueue and dispatch.
    // Return 200 so Cloud Tasks marks it done; nothing to retry.
    reqLog.warn("Job not found; treating as no-op", { jobId })
    sendJson(res, 200, { status: "noop", reason: "job_not_found" })
    return
  }

  if (job.status === "completed" || job.status === "failed") {
    // Already processed (likely a retry after a successful dispatch). No-op.
    reqLog.info("Job already in terminal state; no reprocess", {
      jobId,
      status: job.status,
    })
    sendJson(res, 200, { status: "noop", reason: "already_terminal" })
    return
  }

  // 4. Process. Any failure here is application-level (extraction error,
  //    bad file format) — flip the row to failed and return 200 so Cloud
  //    Tasks doesn't retry. Transport-level failures (GCS unreachable, DB
  //    unreachable) bubble out and get 503, which CT does retry.
  try {
    await processJob(job, reqLog)
    sendJson(res, 200, { status: "completed", jobId })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)

    // Heuristic: if the error came from GCS / DB infrastructure, it's
    // probably transient. Surface as 5xx and let Cloud Tasks retry.
    if (e instanceof Error && /ECONNREFUSED|ETIMEDOUT|503|ENETUNREACH/.test(message)) {
      reqLog.error("Transport-level failure; will retry", { jobId, error: message })
      sendJson(res, 503, { error: "Transient failure" })
      return
    }

    reqLog.error("Job processing failed; marking failed", {
      jobId,
      error: message,
    })
    try {
      await updateJobStatus(jobId, "failed", { errorMessage: message.slice(0, 1000) })
    } catch (writeErr) {
      reqLog.error("Also failed to write failure status", {
        jobId,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      })
    }
    // Still 200 — the failure is recorded, no retry would help.
    sendJson(res, 200, { status: "failed", jobId, error: message })
  }
}

async function handleCleanupJobs(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = generateRequestId()
  const reqLog = createLogger({ requestId, route: "admin.cleanup-jobs" })

  try {
    await verifyOidcToken(req.headers.authorization, {
      audience: expectedAudienceFor(req),
      expectedEmail: requiredEnv("CLEANUP_INVOKER_SA"),
    })
  } catch (e) {
    reqLog.warn("OIDC verification failed", {
      reason: e instanceof Error ? e.message : String(e),
    })
    sendJson(res, 401, { error: "Unauthorized" })
    return
  }

  // Fail-loud on garbage input rather than silently sweeping nothing
  // (parseInt("abc") = NaN; deleteOldJobs(NaN) matches zero rows).
  const raw = process.env.CLEANUP_RETENTION_DAYS ?? "7"
  const parsed = Number.parseInt(raw, 10)
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7
  if (parsed !== days) {
    reqLog.warn("CLEANUP_RETENTION_DAYS is not a positive integer; defaulting to 7", {
      raw,
    })
  }

  try {
    const deleted = await deleteOldJobs(days)
    reqLog.info("deleteOldJobs completed", { deleted, retentionDays: days })
    sendJson(res, 200, { deleted, retentionDays: days })
  } catch (e) {
    reqLog.error("deleteOldJobs failed", {
      error: e instanceof Error ? e.message : String(e),
    })
    sendJson(res, 500, { error: "Cleanup failed" })
  }
}

// ============================================================================
// Core processing
// ============================================================================

async function processJob(
  job: DocumentJob,
  reqLog: ReturnType<typeof createLogger>,
): Promise<void> {
  reqLog.info("Processing job", {
    jobId: job.id,
    fileType: job.fileType,
    fileSize: job.fileSize,
  })

  // Mark in-flight. (confirmDocumentUpload already set status='processing'
  // and progress=10 at upload-confirm time; here we bump the stage label.)
  await updateJobStatus(job.id, "processing", {
    processingStage: "extracting_text",
    progress: 30,
  })

  // 1. Stream the GCS object into a buffer for the extractor.
  // For very large files this is the biggest memory pressure point — but
  // upload size caps in the route handlers bound this. If we ever raise
  // those caps, we'd want a streaming extractor.
  //
  // Key shape comes from the shared getUploadGcsKey helper in gcs-client,
  // which is also what uploadServerProxyDocument uses on the producer side.
  // PR C will replace the v2 upload routes with resumable upload and
  // persist the resulting key on the document_jobs row, removing the
  // need to reconstruct here at all.
  const realKey = getUploadGcsKey(job.id, job.fileName)
  const { stream } = await getObjectStream(realKey)
  const chunks: Buffer[] = []
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  }
  const buffer = Buffer.concat(chunks)

  // 2. Extract.
  const fileType = getFileTypeFromFileName(job.fileName) || job.fileType
  const { text, metadata } = await extractTextFromDocument(buffer, fileType)

  await updateJobStatus(job.id, "processing", {
    processingStage: "chunking_text",
    progress: 70,
  })

  // 3. Chunk (the chunk-default-1000 char size; tunable later).
  const textChunks = chunkText(text)

  // 4. Persist result inline-or-GCS depending on size.
  const resultPayload = {
    text,
    chunks: textChunks,
    metadata,
    chunkCount: textChunks.length,
    extractedAt: new Date().toISOString(),
  }
  const persisted = await persistResult(job.id, resultPayload)

  await updateJobStatus(job.id, "completed", {
    progress: 100,
    processingStage: "completed",
    result: persisted.result,
    resultLocation: persisted.resultLocation,
    resultGcsKey: persisted.resultGcsKey,
    completedAt: new Date().toISOString(),
  })

  reqLog.info("Job processing complete", {
    jobId: job.id,
    chunks: textChunks.length,
    resultLocation: persisted.resultLocation,
  })
}

// ============================================================================
// Server
// ============================================================================

const server = createServer((req, res) => {
  // Per-request error boundary so a thrown promise rejection doesn't crash
  // the process. Cloud Run would restart us, but a clean 500 is friendlier.
  ;(async () => {
    if (req.method === "GET" && req.url === "/healthz") {
      await handleHealth(req, res)
      return
    }
    if (req.method === "POST" && req.url === "/process-job") {
      await handleProcessJob(req, res)
      return
    }
    if (req.method === "POST" && req.url === "/admin/cleanup-jobs") {
      await handleCleanupJobs(req, res)
      return
    }
    sendJson(res, 404, { error: "Not found" })
  })().catch((e) => {
    log.error("Unhandled handler error", {
      url: req.url,
      method: req.method,
      error: e instanceof Error ? e.message : String(e),
    })
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" })
  })
})

server.listen(PORT, () => {
  log.info("document-processor listening", { port: PORT })
})

// Cloud Run sends SIGTERM on revision swap and waits up to 10s before
// SIGKILL. server.close() stops accepting new connections and waits for
// in-flight requests to drain — so a job mid-extraction either completes
// (if it fits in the grace window) or surfaces as a 5xx that Cloud Tasks
// will retry against the new revision, rather than getting silently truncated.
function gracefulShutdown(signal: string): void {
  log.info("Received shutdown signal; draining", { signal })
  server.close((err) => {
    if (err) {
      log.error("server.close errored during shutdown", { error: err.message })
      process.exit(1)
    }
    log.info("Server drained; exiting")
    process.exit(0)
  })
  // Belt-and-suspenders: if a request hangs past Cloud Run's 10s SIGKILL
  // budget, force-exit at 9s so we lose the request rather than getting
  // hard-killed mid-write.
  setTimeout(() => {
    log.warn("Drain timeout exceeded; forcing exit")
    process.exit(1)
  }, 9000).unref()
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
