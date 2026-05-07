import { Readable } from 'node:stream';

type StoredObject = {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
};

const storedObjects = new Map<string, StoredObject>();
const bucketExistsMock = jest.fn<Promise<[boolean]>, []>();
const getSignedUrlMock = jest.fn<Promise<[string]>, [Record<string, unknown>]>();

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: () => ({
      exists: () => bucketExistsMock(),
      file: (key: string) => ({
        save: async (data: Buffer | Uint8Array | string, options: { contentType?: string; metadata?: { metadata?: Record<string, string> } }) => {
          storedObjects.set(key, {
            body: Buffer.isBuffer(data) ? data : Buffer.from(data),
            contentType: options.contentType,
            metadata: options.metadata?.metadata,
          });
        },
        getSignedUrl: (options: Record<string, unknown>) => getSignedUrlMock(options),
        getMetadata: async () => {
          const stored = storedObjects.get(key);
          if (!stored) throw new Error(`Missing object for ${key}`);
          return [{
            contentType: stored.contentType,
            size: stored.body.length.toString(),
            metadata: stored.metadata,
          }];
        },
        createReadStream: () => {
          const stored = storedObjects.get(key);
          if (!stored) throw new Error(`Missing object for ${key}`);
          return Readable.from([stored.body]);
        },
      }),
    }),
  })),
}));

jest.mock('@/lib/utils/uuid', () => ({
  generateUUID: () => 'uuid-123',
}));

import { clearGcsCache } from '@/lib/gcp/gcs-client';
import { getAttachmentFromS3, storeAttachmentInS3 } from '@/lib/services/attachment-storage-service';

describe('attachment storage service → GCS integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      STORAGE_PROVIDER: 'gcs',
      GCS_BUCKET: 'aistudio-test',
      GOOGLE_CLOUD_PROJECT: 'test-project',
    };
    storedObjects.clear();
    bucketExistsMock.mockReset();
    getSignedUrlMock.mockReset();
    bucketExistsMock.mockResolvedValue([true]);
    getSignedUrlMock.mockResolvedValue(['https://storage.googleapis.com/aistudio-test/signed']);
    clearGcsCache();
  });

  afterAll(() => {
    process.env = originalEnv;
    clearGcsCache();
  });

  it('stores and retrieves attachments through the GCS client boundary', async () => {
    const metadata = await storeAttachmentInS3(
      'conv-1',
      'msg-1',
      {
        type: 'document',
        name: 'lesson-plan.pdf',
        data: 'base64-or-text-payload',
        contentType: 'application/pdf',
      },
      0,
    );

    expect(metadata.s3Key).toMatch(/^conversations\/\d+-conv-1\/attachments\/msg-1-0-lesson-plan\.pdf$/);

    const stored = storedObjects.get(metadata.s3Key);
    expect(stored).toBeDefined();
    expect(stored?.contentType).toBe('application/json');
    expect(stored?.metadata).toMatchObject({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      attachmentId: 'uuid-123',
      attachmentType: 'document',
      originalName: 'lesson-plan.pdf',
      userId: 'conversations',
    });

    await expect(getAttachmentFromS3(metadata.s3Key)).resolves.toEqual({
      type: 'document',
      data: 'base64-or-text-payload',
      name: 'lesson-plan.pdf',
      contentType: 'application/pdf',
    });
  });
});
