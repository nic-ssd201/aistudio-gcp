import { getActiveStorageBucketName, getStorageProvider, uploadDocument, generateUploadPresignedUrl } from '@/lib/services/document-storage-service';
import { v4 as uuidv4 } from 'uuid';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';

const gcsClient = new Storage();
const pubsub = new PubSub();

interface FileProcessingJob {
  jobId: string;
  itemId: number;
  fileKey: string;
  fileName: string;
  fileType: string;
  bucketName: string;
}

interface URLProcessingJob {
  jobId: string;
  itemId: number;
  url: string;
  itemName: string;
}

/**
 * Generate a presigned URL for uploading a file to GCS
 */
export async function generateUploadUrl(
  fileName: string,
  contentType: string,
  repositoryId: number
): Promise<{ uploadUrl: string; fileKey: string }> {
  const bucketName = process.env.DOCUMENTS_BUCKET_NAME || process.env.GCS_BUCKET;
  if (!bucketName) {
    throw new Error('DOCUMENTS_BUCKET_NAME or GCS_BUCKET environment variable not set');
    }

    // Generate unique file key
  const fileId = uuidv4();
  const fileKey = `repositories/${repositoryId}/${fileId}/${fileName}`;

    // Create presigned URL for upload (GCS V4 signed URL)
  const bucket = gcsClient.bucket(bucketName);
  const file = bucket.file(fileKey);
  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 3600 * 1000, // 1 hour
    contentType,
     extensionHeaders: {
       'x-goog-meta-contenttype': contentType,
      },
    });

  return { uploadUrl, fileKey };
}

/**
 * Generate presigned URLs for multipart upload (GCS resumable upload)
 */
export async function generateMultipartUploadUrls(
  fileName: string,
  contentType: string,
  repositoryId: number,
  parts: number
): Promise<{
  uploadId: string;
  fileKey: string;
  partUrls: { partNumber: number; uploadUrl: string }[];
}> {
  const bucketName = process.env.DOCUMENTS_BUCKET_NAME || process.env.GCS_BUCKET;
  if (!bucketName) {
    throw new Error('DOCUMENTS_BUCKET_NAME or GCS_BUCKET environment variable not set');
    }

    // Generate unique file key
  const fileId = uuidv4();
  const fileKey = `repositories/${repositoryId}/${fileId}/${fileName}`;

    // GCS uses resumable uploads instead of S3 multipart
    // For now, return a single resumable upload URL (GCS doesn't need part-based uploads)
  const bucket = gcsClient.bucket(bucketName);
  const file = bucket.file(fileKey);

  const [resumableUrl] = await file.createResumableUpload({
    origin: process.env.NEXT_PUBLIC_APP_URL,
    metadata: {
      contentType,
       metadata: {
        repositoryId: repositoryId.toString(),
        uploadedAt: new Date().toISOString(),
       },
      },
    });

  // GCS resumable uploads don't need part URLs — single PUT completes the upload
  return {
    uploadId: `resumable-${fileKey}`,
    fileKey,
    partUrls: [{ partNumber: 1, uploadUrl: resumableUrl }],
    };
}

/**
 * Complete a multipart upload (no-op for GCS — resumable uploads complete on final PUT)
 */
export async function completeMultipartUpload(
  _fileKey: string,
  _uploadId: string,
  _parts: { ETag: string; PartNumber: number }[]
): Promise<void> {
    // GCS resumable uploads complete automatically on the final PUT request.
    // This function is a no-op for parity with the S3 interface.
    return;
}

/**
 * Queue a file for processing via Cloud Pub/Sub
 */
export async function queueFileForProcessing(
  itemId: number,
  fileKey: string,
  fileName: string,
  fileType: string
): Promise<string> {
  const topicName = process.env.FILE_PROCESSING_TOPIC || 'file-processing';

  const jobId = uuidv4();
  const job: FileProcessingJob = {
    jobId,
    itemId,
    fileKey,
    fileName,
    fileType,
    bucketName: process.env.DOCUMENTS_BUCKET_NAME || process.env.GCS_BUCKET || '',
    };

  const topic = pubsub.topic(topicName);
  const message = Buffer.from(JSON.stringify(job)).toString('base64');

  await topic.publishMessage({
    data: message,
    attributes: {
      itemId: itemId.toString(),
      jobType: 'file',
      },
    });

  return jobId;
}

/**
 * Process a URL directly (invoke Cloud Run Job)
 */
export async function processUrl(
  itemId: number,
  url: string,
  itemName: string
): Promise<string> {
  const jobId = uuidv4();
  const job: URLProcessingJob = {
    jobId,
    itemId,
    url,
    itemName,
    };

    // TODO: Wire up to Cloud Run Job invocation via gcloud or REST API
    // For now, publish to a URL processing topic as a placeholder
  const topicName = process.env.URL_PROCESSING_TOPIC || 'url-processing';
  const topic = pubsub.topic(topicName);

  await topic.publishMessage({
    data: Buffer.from(JSON.stringify(job)).toString('base64'),
    attributes: {
      itemId: itemId.toString(),
      },
    });

  return jobId;
}

/**
 * Get supported file types and their MIME types
 */
export function getSupportedFileTypes(): Record<string, string> {
  return {
     'application/pdf': '.pdf',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
     'application/msword': '.doc',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
     'application/vnd.ms-excel': '.xls',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
     'application/vnd.ms-powerpoint': '.ppt',
     'text/plain': '.txt',
     'text/markdown': '.md',
     'text/csv': '.csv',
    };
}

/**
 * Check if a file type is supported
 */
export function isFileTypeSupported(contentType: string): boolean {
  return contentType in getSupportedFileTypes();
}

// Note: getMaxFileSize has been moved to @/lib/file-validation for centralization
// Import from there if needed: import { getMaxFileSize } from '@/lib/file-validation'
