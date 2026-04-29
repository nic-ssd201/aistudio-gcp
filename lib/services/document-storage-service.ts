export type StorageProvider = 'gcs';

const DEFAULT_DOCUMENTS_BUCKET = 'aistudio-documents';

export function getStorageProvider(): StorageProvider {
  return 'gcs';
}

export function getActiveStorageBucketName(): string {
  // GCS is now the only storage provider
  return process.env.GCS_BUCKET || process.env.DOCUMENTS_BUCKET_NAME || DEFAULT_DOCUMENTS_BUCKET;
}

export async function uploadServerProxyDocument(
  params: import('@/lib/gcp/gcs-client').UploadDocumentParams,
) {
  const { uploadDocument } = await import('@/lib/gcp/gcs-client');
  return uploadDocument(params);
}

export async function uploadDocument(params: import('@/lib/gcp/gcs-client').UploadDocumentParams) {
  const { uploadDocument } = await import('@/lib/gcp/gcs-client');
  return uploadDocument(params);
}

export async function getDocumentSignedUrl(params: import('@/lib/gcp/gcs-client').DocumentUrlParams) {
  const { getDocumentSignedUrl } = await import('@/lib/gcp/gcs-client');
  return getDocumentSignedUrl(params);
}

export async function getObjectStream(key: string) {
  const { getObjectStream } = await import('@/lib/gcp/gcs-client');
  return getObjectStream(key);
}

export async function documentExists(key: string) {
  const { documentExists } = await import('@/lib/gcp/gcs-client');
  return documentExists(key);
}

export async function deleteDocument(key: string) {
  const { deleteDocument } = await import('@/lib/gcp/gcs-client');
  return deleteDocument(key);
}

export async function generateUploadPresignedUrl(
  params: import('@/lib/gcp/gcs-client').PresignedUploadUrlParams,
) {
  const { generateUploadPresignedUrl } = await import('@/lib/gcp/gcs-client');
  return generateUploadPresignedUrl(params);
}
