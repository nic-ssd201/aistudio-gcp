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
    const [buckets] = await gcsClient.getBuckets()
    const exists = buckets.some(b => b.name === bucketName)
    
    if (!exists) {
       // Create bucket if it doesn't exist
      try {
        await gcsClient.createBucket(bucketName, {
          location: config.region || "US",
         })
        
         // Set CORS configuration for browser uploads
        const bucket = gcsClient.bucket(bucketName)
        await bucket.setMetadata({
          cors: [
             {
              responseHeader: ["ETag"],
              method: ["GET", "PUT", "POST", "DELETE", "HEAD"],
              origin: [process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"],
              maxAgeSeconds: 3000,
             },
           ],
         })
       } catch (createErr) {
        throw createError("Failed to create GCS bucket", {
          code: "GCS_BUCKET_CREATE_ERROR",
          details: {
            error: createErr instanceof Error ? createErr.message : String(createErr),
            bucket: bucketName,
           }
         })
       }
     }
   } catch (error) {
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
      metadata: {
         ...metadata,
        userId,
        uploadedAt: new Date().toISOString(),
       },
     })

      // Generate a signed URL for immediate access
    const [url] = await file.getSignedUrl({
      action: "read",
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
    await file.delete()
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
      size: parseInt(file.metadata.contentLength || '0', 10),
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
    
    const [url] = await file.getSignedUrl({
      action: "write",
      expires: Date.now() + expiresIn * 1000,
      contentType,
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

    return {
      stream,
      contentType: file.metadata.contentType || undefined,
      contentLength: file.metadata.contentLength ? parseInt(file.metadata.contentLength, 10) : undefined,
      metadata: file.metadata.metadata as Record<string, string> || {},
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

// Helper to extract file key from GCS URL
export async function extractKeyFromUrl(url: string): Promise<string | null> {
  try {
    const config = await getGCSConfig();
    const bucketName = config.bucket!;
    const urlObj = new URL(url)
      // Handle GCS signed URLs - extract the object path from the URL
    const pathMatch = urlObj.pathname.match(/^\/([^/]+)\/(.+)$/)
    if (pathMatch && pathMatch[1] === bucketName) {
      return decodeURIComponent(pathMatch[2])
     }
      // For direct GCS URLs
    if (urlObj.hostname.startsWith(`${bucketName}.`)) {
      return decodeURIComponent(urlObj.pathname.substring(1))
     }
    return null
   } catch {
    return null
   }
}
