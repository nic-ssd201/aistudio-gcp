const generateS3PresignedUrl = jest.fn();
const generateMultipartUrls = jest.fn();
const sanitizeFileName = jest.fn((value: string) => value.replace(/[^\w.-]/g, '_'));
const generateGcsUploadPresignedUrl = jest.fn();
const resumableUpload = jest.fn();

jest.mock('@/lib/aws/document-upload', () => ({
  generatePresignedUrl: (jobId: string, fileName: string) => generateS3PresignedUrl(jobId, fileName),
  generateMultipartUrls: (jobId: string, fileName: string, partCount: number) => generateMultipartUrls(jobId, fileName, partCount),
  sanitizeFileName: (value: string) => sanitizeFileName(value),
}));

jest.mock('@/lib/gcp/gcs-client', () => ({
  generateUploadPresignedUrl: (params: unknown) => generateGcsUploadPresignedUrl(params),
  resumableUpload: (params: unknown) => resumableUpload(params),
}));

import {
  createDocumentUploadConfig,
  getDocumentUploadBucketName,
  resolveUploadedDocumentKey,
} from '../document-upload-service';

describe('document-upload-service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.STORAGE_PROVIDER;
    delete process.env.GCS_BUCKET;
    generateS3PresignedUrl.mockReset();
    generateMultipartUrls.mockReset();
    sanitizeFileName.mockClear();
    generateGcsUploadPresignedUrl.mockReset();
    resumableUpload.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses S3 presigned uploads by default for small files', async () => {
    generateS3PresignedUrl.mockResolvedValue({
      uploadId: 'job-123',
      url: 'https://s3.example/upload',
      method: 'single',
    });

    await expect(createDocumentUploadConfig({
      jobId: 'job-123',
      fileName: 'notes.pdf',
      fileSize: 1024,
      fileType: 'application/pdf',
    })).resolves.toEqual({
      uploadId: 'job-123',
      url: 'https://s3.example/upload',
      method: 'single',
    });

    expect(generateS3PresignedUrl).toHaveBeenCalledWith('job-123', 'notes.pdf');
    expect(generateMultipartUrls).not.toHaveBeenCalled();
  });

  it('uses a GCS resumable session for large files when STORAGE_PROVIDER=gcs', async () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    resumableUpload.mockResolvedValue({
      key: 'v2/uploads/job-456/1700000000000-large_file.pdf',
      url: 'https://storage.googleapis.com/upload/resumable',
      fields: {
        'Content-Type': 'application/pdf',
        'Content-Length': '20971520',
      },
    });

    await expect(createDocumentUploadConfig({
      jobId: 'job-456',
      fileName: 'large file.pdf',
      fileSize: 20 * 1024 * 1024,
      fileType: 'application/pdf',
    })).resolves.toEqual({
      uploadId: 'v2/uploads/job-456/1700000000000-large_file.pdf',
      url: 'https://storage.googleapis.com/upload/resumable',
      method: 'resumable',
    });

    expect(resumableUpload).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'v2/uploads/job-456',
      fileName: 'large_file.pdf',
      contentType: 'application/pdf',
      fileSize: 20 * 1024 * 1024,
      metadata: expect.objectContaining({
        jobId: 'job-456',
        originalFileName: 'large file.pdf',
      }),
    }));
    expect(generateMultipartUrls).not.toHaveBeenCalled();
  });

  it('resolves keys and bucket names from the active provider', () => {
    expect(resolveUploadedDocumentKey({
      uploadId: 'multipart-123',
      jobId: 'job-123',
      fileName: 'notes.pdf',
    })).toBe('v2/uploads/job-123/notes.pdf');

    process.env.STORAGE_PROVIDER = 'gcs';
    process.env.GCS_BUCKET = 'gcs-documents';

    expect(resolveUploadedDocumentKey({
      uploadId: 'v2/uploads/job-999/1700000000000-notes.pdf',
      jobId: 'job-999',
      fileName: 'notes.pdf',
    })).toBe('v2/uploads/job-999/1700000000000-notes.pdf');
    expect(getDocumentUploadBucketName()).toBe('gcs-documents');
  });
});
