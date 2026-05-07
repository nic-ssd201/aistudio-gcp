import {
  generatePresignedUrl as generateS3PresignedUrl,
  generateMultipartUrls,
  sanitizeFileName,
} from '@/lib/aws/document-upload';
import { getActiveStorageBucketName, getStorageProvider } from '@/lib/services/document-storage-service';

export type ProviderUploadMethod = 'single' | 'multipart' | 'resumable';

export interface ProviderUploadConfig {
  uploadId: string;
  url?: string;
  method: ProviderUploadMethod;
  partUrls?: Array<{
    partNumber: number;
    uploadUrl: string;
  }>;
}

const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;

export async function createDocumentUploadConfig(params: {
  jobId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}): Promise<ProviderUploadConfig> {
  const { jobId, fileName, fileSize, fileType } = params;

  if (getStorageProvider() !== 'gcs') {
    if (fileSize < MULTIPART_THRESHOLD_BYTES) {
      return generateS3PresignedUrl(jobId, fileName);
    }

    const partSize = 5 * 1024 * 1024;
    const partCount = Math.ceil(fileSize / partSize);
    return generateMultipartUrls(jobId, fileName, partCount);
  }

  const sanitizedFileName = sanitizeFileName(fileName);
  const uploadParams = {
    userId: `v2/uploads/${jobId}`,
    fileName: sanitizedFileName,
    contentType: fileType,
    fileSize,
    metadata: {
      jobId,
      originalFileName: fileName,
      uploadTimestamp: Date.now().toString(),
    },
  };

  if (fileSize < MULTIPART_THRESHOLD_BYTES) {
    const { generateUploadPresignedUrl } = await import('@/lib/gcp/gcs-client');
    const upload = await generateUploadPresignedUrl(uploadParams);
    return {
      uploadId: upload.key,
      url: upload.url,
      method: 'single',
    };
  }

  const { resumableUpload } = await import('@/lib/gcp/gcs-client');
  const upload = await resumableUpload(uploadParams);
  return {
    uploadId: upload.key,
    url: upload.url,
    method: 'resumable',
  };
}

export function resolveUploadedDocumentKey(params: {
  uploadId: string;
  jobId: string;
  fileName: string;
}): string {
  const { uploadId, jobId, fileName } = params;

  if (getStorageProvider() === 'gcs') {
    return uploadId;
  }

  return `v2/uploads/${jobId}/${sanitizeFileName(fileName)}`;
}

export function getDocumentUploadBucketName(): string {
  return getActiveStorageBucketName();
}
