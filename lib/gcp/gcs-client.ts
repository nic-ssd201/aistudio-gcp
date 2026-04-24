/**
 * GCS client — 1:1 surface mirror of `lib/aws/s3-client.ts`.
 *
 * Slice E1 deliverable per docs/plans/2026-04-21-gcs-object-storage-slice.md.
 *
 * Every exported function name, parameter shape, and return shape matches the
 * S3 module. This makes E2 (the call-site import swap) a pure find-and-replace
 * diff with no behavior changes to reason about at the caller.
 *
 * Protocol-level changes (multipart -> resumable) are intentionally deferred
 * to E3 so E2 can be reviewed in isolation.
 */

import { Storage, type Bucket, type File } from "@google-cloud/storage"
import { Readable } from "node:stream"
import { createError } from "@/lib/error-utils"

// --------- module-level caches (match s3-client.ts pattern) ---------

let gcsConfigCache: { bucket: string; projectId: string | undefined } | null = null
let gcsClientCache: Storage | null = null
const DEFAULT_GCS_BUCKET = "aistudio-documents"

/**
 * Resolve GCS config. For the E1 additive slice we read env vars directly.
 * Follow-up: add `Settings.getGCS()` alongside `Settings.getS3()` and switch
 * this to the same cached-lookup pattern (tracked in E2 deliverables).
 */
function getGcsConfig() {
  if (gcsConfigCache) return gcsConfigCache

  const bucket =
    // Temporary compatibility fallback for local/dev and older env wiring.
    // Staging/prod Cloud Run should always set GCS_BUCKET explicitly.
    process.env.GCS_BUCKET ||
    process.env.DOCUMENTS_BUCKET_NAME ||
    DEFAULT_GCS_BUCKET
  const projectId =
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    undefined // let ADC infer on Cloud Run

  gcsConfigCache = { bucket, projectId }
  return gcsConfigCache
}

function getGcsClient(): Storage {
  if (gcsClientCache) return gcsClientCache
  const { projectId } = getGcsConfig()
  // In Cloud Run this uses the runtime service account via ADC.
  // Locally it honors GOOGLE_APPLICATION_CREDENTIALS.
  gcsClientCache = new Storage(projectId ? { projectId } : undefined)
  return gcsClientCache
}

function getBucket(): Bucket {
  const { bucket } = getGcsConfig()
  return getGcsClient().bucket(bucket)
}

/** Matches `clearS3Cache()`. Called when settings change. */
export function clearGcsCache(): void {
  gcsConfigCache = null
  gcsClientCache = null
}

// --------- exported types (same names/shapes as s3-client.ts) ---------

export interface UploadDocumentParams {
  userId: string
  fileName: string
  fileContent: Buffer | Uint8Array | string
  contentType: string
  metadata?: Record<string, string>
}

export interface DocumentUrlParams {
  key: string
  /** seconds, default 3600 (1 hour) */
  expiresIn?: number
}

export interface PresignedUploadUrlParams {
  userId: string
  fileName: string
  contentType: string
  fileSize: number
  metadata?: Record<string, string>
  /** seconds, default 3600 (1 hour) */
  expiresIn?: number
}

export interface ResumableUploadSession {
  url: string
  key: string
  fields: Record<string, string>
}

export interface ProxyUploadParams {
  jobId: string
  fileName: string
  fileBuffer?: Buffer
  fileStream?: ReadableStream<Uint8Array>
  contentType: string
}

export interface ProxyUploadResult {
  key: string
  bucket: string
  sanitizedFileName: string
}

// --------- bucket-level ---------

/**
 * GCS buckets are provisioned by Terraform (infra-gcp/modules/storage) — the
 * app does not create them at runtime. This function exists for API parity
 * with s3-client and is a no-op assertion that the bucket is reachable.
 */
export async function ensureDocumentsBucket(): Promise<void> {
  const { bucket: bucketName } = getGcsConfig()
  try {
    const [exists] = await getBucket().exists()
    if (!exists) {
      throw createError("GCS bucket not found", {
        code: "GCS_BUCKET_MISSING",
        details: {
          bucket: bucketName,
          hint: "Buckets are provisioned by Terraform in infra-gcp/modules/storage. Run terraform apply for the target env before starting the app.",
        },
      })
    }
  } catch (error) {
    // Re-throw already-wrapped errors unchanged
    if (error instanceof Error && error.message === "GCS bucket not found") throw error
    throw createError("Failed to reach GCS bucket", {
      code: "GCS_BUCKET_CHECK_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        bucket: bucketName,
      },
    })
  }
}

// --------- object-level ---------

/** Upload a document and return its key + a short-lived read URL. */
export async function uploadDocument({
  userId,
  fileName,
  fileContent,
  contentType,
  metadata = {},
}: UploadDocumentParams): Promise<{ key: string; url: string }> {
  await ensureDocumentsBucket()

  const bucket = getBucket()
  const timestamp = Date.now()
  const key = `${userId}/${timestamp}-${fileName}`
  const file = bucket.file(key)

  try {
    const body =
      typeof fileContent === "string" ? Buffer.from(fileContent) : Buffer.from(fileContent)

    await file.save(body, {
      contentType,
      metadata: {
        contentType,
        // GCS stores custom metadata under `metadata.metadata`
        metadata: {
          ...metadata,
          userId,
          uploadedAt: new Date().toISOString(),
        },
      },
      // Turn off resumable for small direct uploads; resumable is E3's job.
      resumable: false,
    })

    const url = await signedReadUrl(file, 3600)
    return { key, url }
  } catch (error) {
    throw createError("Failed to upload document to GCS", {
      code: "GCS_UPLOAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
      },
    })
  }
}

export async function uploadServerProxyDocument({
  jobId,
  fileName,
  fileBuffer,
  fileStream,
  contentType,
}: ProxyUploadParams): Promise<ProxyUploadResult> {
  await ensureDocumentsBucket()

  const { bucket: bucketName } = getGcsConfig()
  const sanitizedFileName = sanitizeProxyFileName(fileName)
  const key = `v2/uploads/${jobId}/${sanitizedFileName}`

  try {
    const body = await toUploadBuffer({ fileBuffer, fileStream })

    await getBucket().file(key).save(body, {
      contentType,
      metadata: {
        contentType,
        metadata: {
          jobId,
          originalFileName: fileName,
          uploadTimestamp: Date.now().toString(),
        },
      },
      resumable: false,
    })

    return {
      key,
      bucket: bucketName,
      sanitizedFileName,
    }
  } catch (error) {
    throw createError("Failed to upload document to GCS", {
      code: "GCS_UPLOAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
      },
    })
  }
}

/** V4 signed read URL for an object. */
export async function getDocumentSignedUrl({
  key,
  expiresIn = 3600,
}: DocumentUrlParams): Promise<string> {
  try {
    return await signedReadUrl(getBucket().file(key), expiresIn)
  } catch (error) {
    throw createError("Failed to generate signed URL", {
      code: "GCS_SIGNED_URL_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      },
    })
  }
}

/** Delete an object. No-op on the S3 side when the object is missing; GCS throws 404 — we swallow it for parity. */
export async function deleteDocument(key: string): Promise<void> {
  try {
    await getBucket().file(key).delete({ ignoreNotFound: true })
  } catch (error) {
    throw createError("Failed to delete document from GCS", {
      code: "GCS_DELETE_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      },
    })
  }
}

/** HEAD-equivalent: returns whether the object exists. */
export async function documentExists(key: string): Promise<boolean> {
  try {
    const [exists] = await getBucket().file(key).exists()
    return exists
  } catch (error) {
    throw createError("Failed to check document existence", {
      code: "GCS_HEAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      },
    })
  }
}

/** List objects under the user's prefix. */
export async function listUserDocuments(
  userId: string,
  maxKeys: number = 1000,
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  try {
    const [files] = await getBucket().getFiles({
      prefix: `${userId}/`,
      maxResults: maxKeys,
      // No `autoPaginate: false` here — we cap via maxResults for parity with S3's MaxKeys.
    })

    return files.map((f) => {
      // GCS returns size as string on the metadata object; normalize to number.
      const size =
        typeof f.metadata.size === "string"
          ? Number.parseInt(f.metadata.size, 10)
          : Number(f.metadata.size ?? 0)
      const updated =
        typeof f.metadata.updated === "string"
          ? new Date(f.metadata.updated)
          : new Date()
      return {
        key: f.name,
        size: Number.isFinite(size) ? size : 0,
        lastModified: updated,
      }
    })
  } catch (error) {
    throw createError("Failed to list user documents", {
      code: "GCS_LIST_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        userId,
      },
    })
  }
}

/**
 * V4 signed PUT URL for browser-direct upload.
 *
 * NOTE: E3 replaces this path with GCS resumable session URIs. For E1/E2 we
 * keep the single-PUT signature so call sites don't change between slices.
 */
export async function generateUploadPresignedUrl({
  userId,
  fileName,
  contentType,
  fileSize,
  metadata = {},
  expiresIn = 3600,
}: PresignedUploadUrlParams): Promise<{ url: string; key: string; fields: Record<string, string> }> {
  await ensureDocumentsBucket()

  const timestamp = Date.now()
  const sanitizedFileName = fileName.replace(/[^\w.-]/g, "_")
  const key = `${userId}/${timestamp}-${sanitizedFileName}`

  try {
    const [url] = await getBucket()
      .file(key)
      .getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + expiresIn * 1000,
        contentType,
        // GCS extensionHeaders map — bind metadata into the signature so the
        // PUT request MUST match. Mirrors S3 Metadata binding.
        extensionHeaders: {
          "x-goog-meta-userid": userId,
          "x-goog-meta-uploadedat": new Date().toISOString(),
          "x-goog-meta-originalname": fileName,
          ...Object.fromEntries(
            Object.entries(metadata).map(([k, v]) => [`x-goog-meta-${k.toLowerCase()}`, v]),
          ),
        },
      })

    // Parity fields with s3-client: Content-Type + Content-Length. The
    // caller forwards these as request headers; GCS honors them.
    const fields: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": fileSize.toString(),
    }

    return { url, key, fields }
  } catch (error) {
    throw createError("Failed to generate presigned upload URL", {
      code: "GCS_PRESIGNED_URL_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
      },
    })
  }
}

/** Stream an object out of GCS for server-side processing. */
/**
 * Create a resumable upload session URI for large browser-direct uploads.
 *
 * The params/return shape intentionally mirrors generateUploadPresignedUrl so
 * provider selection can stay thin at the call site.
 */
export async function resumableUpload({
  userId,
  fileName,
  contentType,
  fileSize,
  metadata = {},
}: PresignedUploadUrlParams): Promise<ResumableUploadSession> {
  await ensureDocumentsBucket()

  const timestamp = Date.now()
  const sanitizedFileName = fileName.replace(/[^\w.-]/g, "_")
  const key = `${userId}/${timestamp}-${sanitizedFileName}`

  try {
    const [url] = await getBucket()
      .file(key)
      .createResumableUpload({
        origin: process.env.NEXT_PUBLIC_APP_URL,
        metadata: {
          contentType,
          metadata: {
            ...metadata,
            userId,
            uploadedAt: new Date().toISOString(),
            originalName: fileName,
          },
        },
      })

    return {
      url,
      key,
      fields: {
        "Content-Type": contentType,
        "Content-Length": fileSize.toString(),
      },
    }
  } catch (error) {
    throw createError("Failed to create resumable upload session", {
      code: "GCS_RESUMABLE_UPLOAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
      },
    })
  }
}

export async function getObjectStream(key: string): Promise<{
  stream: Readable
  contentType?: string
  contentLength?: number
  metadata?: Record<string, string>
}> {
  const file = getBucket().file(key)
  try {
    // Fetch metadata once so we can return content-type/length alongside.
    const [meta] = await file.getMetadata()
    const stream = file.createReadStream() as unknown as Readable

    const contentLength =
      typeof meta.size === "string" ? Number.parseInt(meta.size, 10) : Number(meta.size ?? 0)

    return {
      stream,
      contentType: meta.contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      metadata: (meta.metadata as Record<string, string> | undefined) ?? undefined,
    }
  } catch (error) {
    throw createError("Failed to get object stream from GCS", {
      code: "GCS_GET_STREAM_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      },
    })
  }
}

/**
 * Extract the object key from a GCS URL.
 *
 * Supports the two canonical URL shapes:
 *   https://storage.googleapis.com/<bucket>/<key>
 *   https://<bucket>.storage.googleapis.com/<key>
 *
 * Also accepts `gs://<bucket>/<key>` for completeness.
 */
export async function extractKeyFromUrl(url: string): Promise<string | null> {
  try {
    const { bucket: bucketName } = getGcsConfig()

    if (url.startsWith("gs://")) {
      const rest = url.slice("gs://".length)
      const slash = rest.indexOf("/")
      if (slash === -1) return null
      const b = rest.slice(0, slash)
      const k = rest.slice(slash + 1)
      return b === bucketName ? decodeURIComponent(k) : null
    }

    const u = new URL(url)

    // storage.googleapis.com/<bucket>/<key>
    if (u.hostname === "storage.googleapis.com") {
      const m = u.pathname.match(/^\/([^/]+)\/(.+)$/)
      if (m && m[1] === bucketName) return decodeURIComponent(m[2])
      return null
    }

    // <bucket>.storage.googleapis.com/<key>
    if (u.hostname === `${bucketName}.storage.googleapis.com`) {
      return decodeURIComponent(u.pathname.replace(/^\//, ""))
    }

    return null
  } catch {
    return null
  }
}

// --------- internal helpers ---------

async function toUploadBuffer({
  fileBuffer,
  fileStream,
}: Pick<ProxyUploadParams, "fileBuffer" | "fileStream">): Promise<Buffer> {
  if (fileBuffer) {
    return fileBuffer
  }

  if (!fileStream) {
    throw new Error("Either fileBuffer or fileStream must be provided")
  }

  const reader = fileStream.getReader()
  const chunks: Uint8Array[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

function sanitizeProxyFileName(fileName: string): string {
  if (!fileName || typeof fileName !== "string") {
    return "unnamed_file"
  }

  const lastDotIndex = fileName.lastIndexOf(".")
  const name = lastDotIndex > 0 ? fileName.substring(0, lastDotIndex) : fileName
  const extension = lastDotIndex > 0 ? fileName.substring(lastDotIndex + 1) : ""

  let sanitizedName = name
    .replace(/[^\w-]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 200)

  const sanitizedExtension = extension.replace(/[^\dA-Za-z]/g, "").substring(0, 10)

  if (!sanitizedName) {
    sanitizedName = "file"
  }

  const reservedNames = [
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
  ]

  if (reservedNames.includes(sanitizedName.toLowerCase())) {
    sanitizedName = `file_${sanitizedName}`
  }

  const finalName = sanitizedExtension ? `${sanitizedName}.${sanitizedExtension}` : sanitizedName
  return finalName.substring(0, 200) || "unnamed_file"
}


async function signedReadUrl(file: File, expiresInSeconds: number): Promise<string> {
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresInSeconds * 1000,
  })
  return url
}
