/**
 * GCP Cloud Tasks — enqueues document-processing jobs on Cloud Run Jobs.
 *
 * Slice E (E5 deliverable) per docs/plans/2026-04-21-gcs-object-storage-slice.md.
 * The actual task dispatch is currently stubbed; the queue API is present so
 * call sites are stable while E5 lands the Cloud Run Job + Cloud Tasks wiring.
 *
 * On Cloud Run this uses ADC (runtime service account). Locally set
 * `GOOGLE_APPLICATION_CREDENTIALS` to a service account key with
 * `cloudtasks.tasks.create` on the target queue.
 */

import { createLogger } from "@/lib/logger"

const log = createLogger({ service: "processing-queue" })

// Dynamic environment variable loading for test compatibility
function getProcessingQueueUrl(): string {
  if (process.env.NODE_ENV === "test") {
    return process.env.PROCESSING_QUEUE_URL || "test-processing-queue-url"
  }

  if (!process.env.PROCESSING_QUEUE_URL) {
    throw new Error(
      "PROCESSING_QUEUE_URL environment variable not configured",
    )
  }

  return process.env.PROCESSING_QUEUE_URL
}

function getHighMemoryQueueUrl(): string {
  if (process.env.NODE_ENV === "test") {
    return process.env.HIGH_MEMORY_QUEUE_URL || "test-high-memory-queue-url"
  }

  if (!process.env.HIGH_MEMORY_QUEUE_URL) {
    throw new Error("HIGH_MEMORY_QUEUE_URL environment variable not configured")
  }

  return process.env.HIGH_MEMORY_QUEUE_URL
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

/**
 * Send a message to the Cloud Tasks queue.
 *
 * The actual task dispatch is deferred to E5 (Cloud Run Job migration).
 * For now this is a no-op stub that logs — it won't break callers.
 */
export async function sendToProcessingQueue(
  message: ProcessingJobMessage,
): Promise<void> {
  try {
    const _queueUrl = getProcessingQueueUrl()

    // Determine which queue to use based on file size (same logic as SQS)
    const _targetQueue =
      message.fileSize > 50 * 1024 * 1024 // 50MB threshold
        ? getHighMemoryQueueUrl()
        : _queueUrl

    log.info("Queued processing task", {
      jobId: message.jobId,
      fileName: message.fileName,
      fileSize: message.fileSize,
      queueType: message.fileSize > 50 * 1024 * 1024 ? "high-memory" : "standard",
    })

    // TODO (E5): Actually enqueue the task via Cloud Tasks API.
    // For now this is a no-op stub — callers won't break, processing just
    // won't start until E5 lands.
    return
  } catch (error) {
    log.error("Failed to queue processing task", {
      error: error instanceof Error ? error.message : String(error),
      jobId: message.jobId,
    })
    throw new Error(
      `Failed to queue processing: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}

/**
 * Send a priority message (immediate processing).
 */
export async function triggerLambdaProcessing(
  jobId: string,
  options?: { priority?: boolean },
): Promise<void> {
  try {
    const _queueUrl = getProcessingQueueUrl()

    log.info("Triggered processing task", {
      jobId,
      priority: options?.priority,
    })

    // TODO (E5): Enqueue with higher priority / no delay via Cloud Tasks.
    return
  } catch (error) {
    log.error("Failed to trigger processing task", {
      error: error instanceof Error ? error.message : String(error),
      jobId,
    })
    throw new Error(
      `Failed to trigger processing: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}

/**
 * Send a batch of messages. Mirrors `sendBatchToProcessingQueue`.
 */
export async function sendBatchToProcessingQueue(
  messages: ProcessingJobMessage[],
): Promise<void> {
  if (messages.length === 0) return

  try {
    await Promise.all(messages.map((m) => sendToProcessingQueue(m)))

    log.info("Sent batch processing tasks", { totalMessages: messages.length })
  } catch (error) {
    log.error("Failed to send batch processing tasks", {
      error: error instanceof Error ? error.message : String(error),
      messageCount: messages.length,
    })
    throw new Error(
      `Failed to queue batch processing: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}

/**
 * Retry a failed job with exponential backoff. Mirrors `retryFailedJob`.
 */
export async function retryFailedJob(
  jobId: string,
  attempt: number = 1,
): Promise<void> {
  try {
    log.info("Queued job retry", { jobId, attempt })

    // TODO (E5): Enqueue with delay via Cloud Tasks.
    return
  } catch (error) {
    log.error("Failed to queue job retry", {
      error: error instanceof Error ? error.message : String(error),
      jobId,
      attempt,
    })
    throw new Error(
      `Failed to queue retry: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}
