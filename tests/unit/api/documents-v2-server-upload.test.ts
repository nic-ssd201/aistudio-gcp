/**
 * @jest-environment node
 */

import { POST } from '@/app/api/documents/v2/upload/route';
import { getServerSession } from '@/lib/auth/server-session';
import { createDocumentJob, confirmDocumentUpload } from '@/lib/services/document-job-service';
import { sendToProcessingQueue } from '@/lib/aws/lambda-trigger';
import { getActiveStorageBucketName, uploadServerProxyDocument } from '@/lib/services/document-storage-service';

jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/services/document-job-service', () => ({
  createDocumentJob: jest.fn(),
  confirmDocumentUpload: jest.fn(),
}));

jest.mock('@/lib/aws/lambda-trigger', () => ({
  sendToProcessingQueue: jest.fn(),
}));

jest.mock('@/lib/services/document-storage-service', () => ({
  getActiveStorageBucketName: jest.fn(),
  uploadServerProxyDocument: jest.fn(),
}));

jest.mock('@/lib/rate-limit', () => ({
  apiRateLimit: {
    upload: (handler: unknown) => handler,
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((value) => value),
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockCreateDocumentJob = createDocumentJob as jest.MockedFunction<typeof createDocumentJob>;
const mockConfirmDocumentUpload = confirmDocumentUpload as jest.MockedFunction<typeof confirmDocumentUpload>;
const mockSendToProcessingQueue = sendToProcessingQueue as jest.MockedFunction<typeof sendToProcessingQueue>;
const mockGetActiveStorageBucketName = getActiveStorageBucketName as jest.MockedFunction<typeof getActiveStorageBucketName>;
const mockUploadServerProxyDocument = uploadServerProxyDocument as jest.MockedFunction<typeof uploadServerProxyDocument>;

function createMockFile() {
  return {
    name: 'district-plan.pdf',
    size: 1024,
    type: 'application/pdf',
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
  };
}

function createMockRequest(file = createMockFile()) {
  return {
    formData: async () => ({
      get(name: string) {
        if (name === 'file') return file;
        if (name === 'purpose') return 'chat';
        return null;
      },
    }),
  } as any;
}

describe('POST /api/documents/v2/upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...process.env, NODE_ENV: 'test' };
    delete process.env.STORAGE_PROVIDER;

    mockGetServerSession.mockResolvedValue({ sub: 'user-123' } as any);
    mockCreateDocumentJob.mockResolvedValue({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' } as any);
    mockConfirmDocumentUpload.mockResolvedValue(undefined);
    mockSendToProcessingQueue.mockResolvedValue(undefined);
  });

  it('routes server-proxy uploads through the AWS-backed storage service by default', async () => {
    mockGetActiveStorageBucketName.mockReturnValue('aws-documents');
    mockUploadServerProxyDocument.mockResolvedValue({
      key: 'v2/uploads/f47ac10b-58cc-4372-a567-0e02b2c3d479/district-plan.pdf',
      bucket: 'aws-documents',
      sanitizedFileName: 'district-plan.pdf',
    });

    const response = await POST(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      success: true,
      jobId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      status: 'processing',
    });

    expect(mockUploadServerProxyDocument).toHaveBeenCalledWith({
      jobId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      fileName: 'district-plan.pdf',
      fileStream: expect.anything(),
      contentType: 'application/pdf',
    });

    expect(mockConfirmDocumentUpload).toHaveBeenCalledWith(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    );

    expect(mockSendToProcessingQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'aws-documents',
        key: 'v2/uploads/f47ac10b-58cc-4372-a567-0e02b2c3d479/district-plan.pdf',
        fileName: 'district-plan.pdf',
      }),
    );
  });

  it('routes server-proxy uploads through the GCS-backed storage service when enabled', async () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    mockGetActiveStorageBucketName.mockReturnValue('gcs-attachments');
    mockUploadServerProxyDocument.mockResolvedValue({
      key: 'v2/uploads/f47ac10b-58cc-4372-a567-0e02b2c3d479/district-plan.pdf',
      bucket: 'gcs-attachments',
      sanitizedFileName: 'district-plan.pdf',
    });

    const response = await POST(createMockRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    expect(mockUploadServerProxyDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        fileName: 'district-plan.pdf',
      }),
    );

    expect(mockSendToProcessingQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'gcs-attachments',
        key: 'v2/uploads/f47ac10b-58cc-4372-a567-0e02b2c3d479/district-plan.pdf',
      }),
    );
  });
});
