/**
 * GCP Cloud Tasks dispatcher for the document-processing pipeline.
 *
 * Accepts a ProcessingJobMessage from the upload routes and enqueues an HTTP
 * task that fires against the document-processor Cloud Run Service. The task
 * carries a Google-issued OIDC ID token (audience = the service URL), which
 * the receiver verifies before doing any work.
 *
 * Per the SSD201 GCP migration sequencing (PR B in the document-pipeline
 * restoration), this replaces the previous no-op stub. The call sites in
 * /api/documents/v2/{confirm-upload,complete-multipart,upload} did not
 * change shape — they still call `sendToProcessingQueue(message)`.
 *
 * Required env vars (set per-env via Terraform):
 *   PROCESSING_QUEUE_NAME       Fully-qualified Cloud Tasks queue resource:
 *                               projects/<P>/locations/<L>/queues/<Q>
 *   PROCESSING_TARGET_URL       Absolute URL of the document-processor's
 *                               /process-job endpoint
 *   PROCESSING_INVOKER_SA       Service-account email Cloud Tasks should
 *                               sign the OIDC ID token as. The receiver
 *                               verifies the token's `email` claim matches.
 *
 * Auth model:
 *   - This module runs as the cloud-run-web SA, which holds
 *     roles/cloudtasks.enqueuer on PROCESSING_QUEUE_NAME.
 *   - Cloud Tasks signs each outbound request as PROCESSING_INVOKER_SA via
 *     `oidcToken`; that SA holds roles/run.invoker on the processor.
 *   - The processor verifies the OIDC token (Google JWKS) and rejects any
 *     request whose `email` doesn't match PROCESSING_INVOKER_SA.
 */

import { CloudTasksClient } from "@google-cloud/tasks"
import { createLogger } from "@/lib/logger"

const log = createLogger({ service: "processing-queue" })

// Lazy singleton — the gRPC client opens connections on construction; one
// per process is plenty for the dispatch volume we expect.
let cachedClient: CloudTasksClient | null = null
function getClient(): CloudTasksClient {
  if (!cachedClient) cachedClient = new CloudTasksClient()
  return cachedClient
}

/** Reset the singleton (test-only). */
export function _resetForTesting(opts?: { client?: CloudTasksClient }): void {
  cachedClient = opts?.client ?? null
}

/**
 * Resolve a required env var. In test mode (NODE_ENV=test) returns the
 * supplied default so test setups don't need to populate every var.
 */
function requireEnv(name: string, testDefault: string): string {
  if (process.env.NODE_ENV === "test") {
    return process.env[name] ?? testDefault
  }
  const v = process.env[name]
  if (!v) {
    throw new Error(`${name} environment variable is required`)
  }
  return v
}

/** Parse a queue resource path into { project, location, queue } for the SDK. */
function parseQueuePath(qualified: string): {
  project: string
  location: string
  queue: string
} {
  const m = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(
    qualified,
  )
  if (!m) {
    throw new Error(
      `PROCESSING_QUEUE_NAME must be a fully-qualified queue resource path ` +
        `(projects/<P>/locations/<L>/queues/<Q>). Got: "${qualified}"`,
    )
  }
  return { project: m[1], location: m[2], queue: m[3] }
}

export interface ProcessingJobMessage {
  jobId: string
  bucket: string
  key: string
  fileName: string
  fileSize: number
  fileType: string
  userId: string
  processingOptions: {
    extractText: boolean
    convertToMarkdown: boolean
    extractImages: boolean
    generateEmbeddings: boolean
    ocrEnabled: boolean
  }
}

interface SendOpts {
  /** Optional task name suffix for idempotency. Cloud Tasks dedupes by name within ~1h. */
  taskNameSuffix?: string
  /** Delay in seconds before the task becomes eligible for dispatch. Default: 0. */
  delaySeconds?: number
  /** Mark as priority (no delay even when defaultDelay env override is set). */
  priority?: boolean
}

async function enqueueTask(
  message: ProcessingJobMessage,
  opts: SendOpts = {},
): Promise<void> {
  const queueQualified = requireEnv(
    "PROCESSING_QUEUE_NAME",
    "projects/test/locations/us-test/queues/test-queue",
  )
  const targetUrl = requireEnv(
    "PROCESSING_TARGET_URL",
    "http://localhost:0/process-job",
  )
  const invokerSa = requireEnv(
    "PROCESSING_INVOKER_SA",
    "test-invoker@example.iam.gserviceaccount.com",
  )

  const { project, location, queue } = parseQueuePath(queueQualified)
  const parent = getClient().queuePath(project, location, queue)

  // Cloud Tasks supports task names for dedup. We use jobId+suffix so a
  // double-confirm-upload from a retried client doesn't fire the processor
  // twice for the same job. Cloud Tasks remembers names for ~1h after dispatch.
  const suffix = opts.taskNameSuffix ?? "v1"
  const taskName = `${parent}/tasks/${message.jobId}-${suffix}`

  const scheduleTime =
    !opts.priority && opts.delaySeconds && opts.delaySeconds > 0
      ? {
          seconds:
            Math.floor(Date.now() / 1000) + Math.floor(opts.delaySeconds),
        }
      : undefined

  try {
    await getClient().createTask({
      parent,
      task: {
        name: taskName,
        scheduleTime,
        httpRequest: {
          url: targetUrl,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ message })),
          oidcToken: {
            serviceAccountEmail: invokerSa,
            // Default audience is the URL minus the path; supply the full URL
            // so the receiver sees a precise audience claim it can pin.
            audience: targetUrl,
          },
        },
      },
    })
    log.info("Enqueued processing task", {
      jobId: message.jobId,
      fileName: message.fileName,
      delaySeconds: opts.delaySeconds ?? 0,
    })
  } catch (error) {
    // ALREADY_EXISTS: Cloud Tasks rejected because we already enqueued this
    // exact name within the dedup window. Treat as success — the task is in
    // the queue (or was recently dispatched) which is the caller's intent.
    if (
      error instanceof Error &&
      /already exists|6 ALREADY_EXISTS/i.test(error.message)
    ) {
      log.info("Processing task already enqueued (dedup hit)", {
        jobId: message.jobId,
        taskName,
      })
      return
    }
    log.error("Failed to enqueue processing task", {
      jobId: message.jobId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(
      `Failed to queue processing for job ${message.jobId}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    )
  }
}

/** Send a message to the processing queue. */
export async function sendToProcessingQueue(
  message: ProcessingJobMessage,
): Promise<void> {
  await enqueueTask(message)
}

/** Send a priority message (immediate dispatch). */
export async function triggerLambdaProcessing(
  jobId: string,
  options?: { priority?: boolean },
): Promise<void> {
  // Reduced-shape variant retained for back-compat with the legacy SQS API.
  // Callers that only have a jobId can use this; we synthesize a minimal
  // ProcessingJobMessage. For the full happy-path the upload routes call
  // sendToProcessingQueue with a complete payload — preferred.
  await enqueueTask(
    {
      jobId,
      bucket: "",
      key: "",
      fileName: "",
      fileSize: 0,
      fileType: "",
      userId: "",
      processingOptions: {
        extractText: true,
        convertToMarkdown: false,
        extractImages: false,
        generateEmbeddings: false,
        ocrEnabled: false,
      },
    },
    { priority: options?.priority },
  )
}

/** Enqueue a batch of messages. Concurrency is bounded by the Tasks SDK. */
export async function sendBatchToProcessingQueue(
  messages: ProcessingJobMessage[],
): Promise<void> {
  if (messages.length === 0) return
  await Promise.all(messages.map((m) => enqueueTask(m)))
  log.info("Sent batch processing tasks", { totalMessages: messages.length })
}

/**
 * Re-enqueue a failed job with exponential backoff. Cloud Tasks handles
 * retries on its own when the receiver returns 5xx, so this is reserved for
 * application-level retry decisions (e.g. the processor returned 200 but
 * left the job in 'failed' status because the model timed out).
 */
export async function retryFailedJob(
  jobId: string,
  attempt: number = 1,
): Promise<void> {
  const delaySeconds = Math.min(2 ** attempt, 300) // cap at 5 minutes
  await enqueueTask(
    {
      jobId,
      bucket: "",
      key: "",
      fileName: "",
      fileSize: 0,
      fileType: "",
      userId: "",
      processingOptions: {
        extractText: true,
        convertToMarkdown: false,
        extractImages: false,
        generateEmbeddings: false,
        ocrEnabled: false,
      },
    },
    { delaySeconds, taskNameSuffix: `retry-${attempt}` },
  )
}
