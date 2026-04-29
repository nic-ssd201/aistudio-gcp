/**
 * Google Cloud Storage Client
 *
 * GCP equivalent of the old S3 client. Provides document storage, retrieval,
 * and signed URL generation using Google Cloud Storage.
 *
 * Features:
 * - Upload documents to GCS buckets
 * - Generate signed URLs for secure access
 * - Stream objects for efficient processing
 * - Automatic bucket creation with CORS configuration
 */

import { Storage } from "@google-cloud/storage"
import { createError } from "@/lib/error-utils"
import { Settings } from "@/lib/settings-manager"
import type { Readable } from "node:stream"

// Cache GCS config to avoid repeated async calls
let gcsConfigCache: { bucket: string | null; region: string | null } | null = null
let gcsClientCache: Storage | null = null

// Get GCS configuration with caching
async function getGCSConfig() {
  if (gcsConfigCache) {
    return gcsConfigCache
   }
  
  const config = await Settings.getGCS()
  gcsConfigCache = {
    bucket: config.bucket || "aistudio-documents",
    region: config.region || "us-central1"
   }
  
  return gcsConfigCache
}

// Get or create GCS client
export async function getGCSClient() {
  if (gcsClientCache) {
    return gcsClientCache
   }
  
  const config = await getGCSConfig()
  gcsClientCache = new Storage({
      // Uses Application Default Credentials automatically
      // In production (Cloud Run/ECS), this uses IAM service account credentials
      // In development, uses gcloud auth application-default login
    })
  
  return gcsClientCache
}

// Clear cached GCS configuration and client (call this when settings change)
export function clearGCSCache() {
  gcsConfigCache = null
  gcsClientCache = null
}

export interface UploadDocumentParams {
  userId: string
  fileName: string
  fileContent: Buffer | Uint8Array | string
  contentType: string
  metadata?: Record<string, string>
}

export interface DocumentUrlParams {
  key: string
  expiresIn?: number // seconds, default 3600 (1 hour)
}

export interface PresignedUploadUrlParams {
  userId: string
  fileName: string
  contentType: string
  fileSize: number
  metadata?: Record<string, string>
  expiresIn?: number // seconds, default 3600 (1 hour)
}

// Ensure the documents bucket exists
export async function ensureDocumentsBucket(): Promise<void> {
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!

  try {
    const bucket = gcsClient.bucket(bucketName)
    const [exists] = await bucket.exists()

    if (!exists) {
      throw createError("GCS documents bucket does not exist", {
        code: "GCS_BUCKET_MISSING",
        details: { bucket: bucketName }
         })
        }
       } catch (error) {
        // Re-throw our own errors
    if (error instanceof Error && error.code === "GCS_BUCKET_MISSING") {
      throw error
        }
    throw createError("Failed to check GCS bucket", {
      code: "GCS_BUCKET_CHECK_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        bucket: bucketName,
           }
         })
        }
}

// Upload a document to GCS
export async function uploadDocument({
  userId,
  fileName,
  fileContent,
  contentType,
  metadata = {},
}: UploadDocumentParams): Promise<{ key: string; url: string }> {
  await ensureDocumentsBucket()
  
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!

  const timestamp = Date.now()
  const key = `${userId}/${timestamp}-${fileName}`

  try {
    const bucket = gcsClient.bucket(bucketName)
    const file = bucket.file(key)
    
    await file.save(fileContent, {
      contentType: contentType,
      resumable: false,
      metadata: {
        metadata: {
           ...metadata,
          userId,
          uploadedAt: new Date().toISOString(),
            },
          },
        })

         // Generate a signed URL for immediate access
    const [url] = await file.getSignedUrl({
      action: "read",
      version: "v4",
      expires: Date.now() + 3600 * 1000, // 1 hour
     })

    return { key, url }
   } catch (error) {
    throw createError("Failed to upload document to GCS", {
      code: "GCS_UPLOAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
       }
     })
   }
}

// Get a signed URL for a document
export async function getDocumentSignedUrl({
  key,
  expiresIn = 3600,
}: DocumentUrlParams): Promise<string> {
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!
  
  try {
    const bucket = gcsClient.bucket(bucketName)
    const file = bucket.file(key)
    
    const [url] = await file.getSignedUrl({
      action: "read",
      version: "v4",
      expires: Date.now() + expiresIn * 1000,
     })
    return url
   } catch (error) {
    throw createError("Failed to generate signed URL", {
      code: "GCS_SIGNED_URL_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
       }
     })
   }
}

// Delete a document from GCS
export async function deleteDocument(key: string): Promise<void> {
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!
  
  try {
    const bucket = gcsClient.bucket(bucketName)
    const file = bucket.file(key)
    await file.delete({ ignoreNotFound: true })
   } catch (error) {
    throw createError("Failed to delete document from GCS", {
      code: "GCS_DELETE_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
       }
     })
   }
}

// Check if a document exists
export async function documentExists(key: string): Promise<boolean> {
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!
  
  try {
    const bucket = gcsClient.bucket(bucketName)
    const file = bucket.file(key)
    const [exists] = await file.exists()
    return exists
   } catch (error) {
    throw createError("Failed to check document existence", {
      code: "GCS_HEAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
       }
     })
   }
}

// List documents for a user
export async function listUserDocuments(
  userId: string,
  maxKeys: number = 1000
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!
  
  try {
    const bucket = gcsClient.bucket(bucketName)
    const [files] = await bucket.getFiles({
      prefix: `${userId}/`,
      maxResults: maxKeys,
     })
    
    return files.map((file) => ({
      key: file.name,
      size: typeof file.metadata.contentLength === 'number'
        ? file.metadata.contentLength
        : parseInt(String(file.metadata.contentLength || file.metadata.size || '0'), 10),
      lastModified: file.metadata.updated ? new Date(file.metadata.updated) : new Date(),
     }))
   } catch (error) {
    throw createError("Failed to list user documents", {
      code: "GCS_LIST_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        userId,
       }
     })
   }
}
// Generate a presigned URL for uploading a document
export async function generateUploadPresignedUrl({
  userId,
  fileName,
  contentType,
  fileSize,
  metadata = {},
  expiresIn = 3600,
}: PresignedUploadUrlParams): Promise<{ url: string; key: string; fields: Record<string, string> }> {
  await ensureDocumentsBucket()

  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!

  const timestamp = Date.now()
  const sanitizedFileName = fileName.replace(/[^\w.-]/g, '_')
  const key = `${userId}/${timestamp}-${sanitizedFileName}`

  try {
    const bucket = gcsClient.bucket(bucketName)
    const file = bucket.file(key)

     // Build extension headers for GCS metadata
    const extensionHeaders: Record<string, string> = {}
    extensionHeaders["x-goog-meta-userid"] = userId
    for (const [k, v] of Object.entries(metadata)) {
      extensionHeaders[`x-goog-meta-${k}`] = v
     }

    const [url] = await file.getSignedUrl({
      action: "write",
      version: "v4",
      expires: Date.now() + expiresIn * 1000,
      contentType,
      extensionHeaders,
       })

       // Return additional fields that might be needed for the upload
    const fields = {
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
          }
        })
       }
}

// Get object as a stream for efficient processing
export async function getObjectStream(key: string): Promise<{ 
  stream: Readable
  contentType?: string
  contentLength?: number
  metadata?: Record<string, string>
}> {
  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!

  try {
    const bucket = gcsClient.bucket(bucketName)
    const file = bucket.file(key)

    const stream = file.createReadStream()

    if (!stream) {
      throw new Error("No stream returned from GCS")
       }

    const [meta] = await file.getMetadata()

    return {
      stream,
      contentType: meta.contentType || undefined,
      contentLength: typeof meta.size === 'number' ? meta.size : parseInt(String(meta.size || '0'), 10),
      metadata: (meta.metadata as Record<string, string>) || {},
       }
        } catch (error) {
    throw createError("Failed to get object stream from GCS", {
      code: "GCS_GET_STREAM_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
          }
        })
       }
}

// Helper to extract file key from GCS URL (replaces the broken one above)
export async function extractKeyFromUrl(url: string): Promise<string | null> {
  try {
    const config = await getGCSConfig();
    const bucketName = config.bucket!;

     // Handle gs:// URIs
    if (url.startsWith('gs://')) {
      const withoutScheme = url.slice(5)
      const slashIdx = withoutScheme.indexOf('/')
      if (slashIdx === -1) return null
      const uriBucket = withoutScheme.slice(0, slashIdx)
      if (uriBucket !== bucketName) return null
      return decodeURIComponent(withoutScheme.slice(slashIdx + 1))
    }

    const urlObj = new URL(url)
       // Handle GCS signed URLs - extract the object path from the URL
    const pathMatch = urlObj.pathname.match(/^\/([^/]+)\/(.+)$/)
    if (pathMatch && pathMatch[1] === bucketName) {
      return decodeURIComponent(pathMatch[2])
    }
       // For virtual-host-style URLs (bucket.storage.googleapis.com or bucket.storage.cloud.google.com)
    if (urlObj.hostname.endsWith('.storage.googleapis.com') || urlObj.hostname.endsWith('.storage.cloud.google.com')) {
      const hostBucket = urlObj.hostname.split('.')[0]
      if (hostBucket === bucketName) {
        return decodeURIComponent(urlObj.pathname.substring(1))
      }
    }
    return null
  } catch {
    return null
  }
}

// Upload a document for server-proxy (stable key based on jobId)
export async function uploadServerProxyDocument({
  jobId,
  fileName,
  fileBuffer,
  contentType,
}: {
  jobId: string
  fileName: string
  fileBuffer: Buffer | Uint8Array | string
  contentType: string
}): Promise<{ key: string; bucket: string; sanitizedFileName: string }> {
  const config = await getGCSConfig()
  const bucketName = config.bucket!

  // Sanitize filename (replace spaces with underscores)
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `v2/uploads/${jobId}/${sanitizedFileName}`

  await ensureDocumentsBucket()

  const gcsClient = await getGCSClient()
  const bucket = gcsClient.bucket(bucketName)
  const file = bucket.file(key)

  await file.save(fileBuffer, {
    contentType: contentType,
      resumable: false,
    resumable: false,
    metadata: {
      metadata: {
        jobId,
        originalFileName: fileName,
      },
    },
  })

  return { key, bucket: bucketName, sanitizedFileName }
}

// Resumable upload session for large files
export async function resumableUpload({
  userId,
  fileName,
  contentType,
  fileSize,
  metadata = {},
}: {
  userId: string
  fileName: string
  contentType: string
  fileSize: number
  metadata?: Record<string, string>
}): Promise<{ url: string; key: string; fields: Record<string, string> }> {
  await ensureDocumentsBucket()

  const gcsClient = await getGCSClient()
  const config = await getGCSConfig()
  const bucketName = config.bucket!

  const timestamp = Date.now()
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `${userId}/${timestamp}-${sanitizedFileName}`

  const bucket = gcsClient.bucket(bucketName)
  const file = bucket.file(key)

  const [uri] = await file.createResumableUpload({
    metadata: {
      contentType,
      metadata: {
        ...metadata,
        userId,
        originalName: fileName,
      },
    },
  })

  return {
    url: uri,
    key,
    fields: {
      "Content-Type": contentType,
      "Content-Length": fileSize.toString(),
    },
  }
}
export { clearGCSCache as clearGcsCache };
