export type StorageProvider = 'gcs';

const DEFAULT_DOCUMENTS_BUCKET = 'aistudio-documents';

export function getStorageProvider(): StorageProvider {
  return 'gcs';
}

export function getActiveStorageBucketName(): string {
  // GCS is now the only storage provider
  return process.env.GCS_BUCKET || process.env.DOCUMENTS_BUCKET_NAME || DEFAULT_DOCUMENTS_BUCKET;
}

export interface ServerProxyUploadParams {
  jobId: string;
  fileName: string;
  fileBuffer?: Buffer | Uint8Array | string;
  fileStream?: ReadableStream<Uint8Array>;
  contentType: string;
}

export async function uploadServerProxyDocument(
  params: ServerProxyUploadParams,
): Promise<{ key: string; bucket: string; sanitizedFileName: string }> {
  const { uploadServerProxyDocument: gcsUpload } = await import('@/lib/gcp/gcs-client');

  let fileBuffer: Buffer | Uint8Array | string;
  if (params.fileStream) {
    const chunks: Uint8Array[] = [];
    const reader = params.fileStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    fileBuffer = Buffer.concat(chunks);
  } else if (params.fileBuffer !== undefined) {
    fileBuffer = params.fileBuffer;
  } else {
    throw new Error('Either fileBuffer or fileStream must be provided');
  }

  return gcsUpload({ jobId: params.jobId, fileName: params.fileName, fileBuffer, contentType: params.contentType });
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
