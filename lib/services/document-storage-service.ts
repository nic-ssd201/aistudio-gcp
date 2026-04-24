export type StorageProvider = 'aws-s3' | 'gcs';

const DEFAULT_DOCUMENTS_BUCKET = 'aistudio-documents';

export function getStorageProvider(): StorageProvider {
  return process.env.STORAGE_PROVIDER === 'gcs' ? 'gcs' : 'aws-s3';
}

export function getActiveStorageBucketName(): string {
  if (getStorageProvider() === 'gcs') {
    // Temporary compatibility fallback for local/dev and pre-Terraform env wiring.
    // Staging/prod Cloud Run should always set GCS_BUCKET explicitly.
    return process.env.GCS_BUCKET || process.env.DOCUMENTS_BUCKET_NAME || DEFAULT_DOCUMENTS_BUCKET;
  }

  return process.env.DOCUMENTS_BUCKET_NAME || DEFAULT_DOCUMENTS_BUCKET;
}

export async function uploadServerProxyDocument(
  params: import('@/lib/aws/document-upload').DirectUploadConfig,
) {
  if (getStorageProvider() === 'gcs') {
    const { uploadServerProxyDocument } = await import('@/lib/gcp/gcs-client');
    return uploadServerProxyDocument(params);
  }

  const { uploadToS3 } = await import('@/lib/aws/document-upload');
  const result = await uploadToS3(params);

  return {
    key: result.s3Key,
    bucket: result.bucket,
    sanitizedFileName: result.sanitizedFileName,
  };
}

export async function uploadDocument(params: import('@/lib/aws/s3-client').UploadDocumentParams) {
  if (getStorageProvider() === 'gcs') {
    const { uploadDocument } = await import('@/lib/gcp/gcs-client');
    return uploadDocument(params);
  }

  const { uploadDocument } = await import('@/lib/aws/s3-client');
  return uploadDocument(params);
}

export async function getDocumentSignedUrl(params: import('@/lib/aws/s3-client').DocumentUrlParams) {
  if (getStorageProvider() === 'gcs') {
    const { getDocumentSignedUrl } = await import('@/lib/gcp/gcs-client');
    return getDocumentSignedUrl(params);
  }

  const { getDocumentSignedUrl } = await import('@/lib/aws/s3-client');
  return getDocumentSignedUrl(params);
}

export async function getObjectStream(key: string) {
  if (getStorageProvider() === 'gcs') {
    const { getObjectStream } = await import('@/lib/gcp/gcs-client');
    return getObjectStream(key);
  }

  const { getObjectStream } = await import('@/lib/aws/s3-client');
  return getObjectStream(key);
}

export async function documentExists(key: string) {
  if (getStorageProvider() === 'gcs') {
    const { documentExists } = await import('@/lib/gcp/gcs-client');
    return documentExists(key);
  }

  const { documentExists } = await import('@/lib/aws/s3-client');
  return documentExists(key);
}

export async function deleteDocument(key: string) {
  if (getStorageProvider() === 'gcs') {
    const { deleteDocument } = await import('@/lib/gcp/gcs-client');
    return deleteDocument(key);
  }

  const { deleteDocument } = await import('@/lib/aws/s3-client');
  return deleteDocument(key);
}

export async function generateUploadPresignedUrl(
  params: import('@/lib/aws/s3-client').PresignedUploadUrlParams,
) {
  if (getStorageProvider() === 'gcs') {
    const { generateUploadPresignedUrl } = await import('@/lib/gcp/gcs-client');
    return generateUploadPresignedUrl(params);
  }

  const { generateUploadPresignedUrl } = await import('@/lib/aws/s3-client');
  return generateUploadPresignedUrl(params);
}
