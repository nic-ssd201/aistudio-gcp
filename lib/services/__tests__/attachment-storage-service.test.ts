const uploadDocumentToS3 = jest.fn();
const getS3ObjectStream = jest.fn();
const uploadDocumentToGcs = jest.fn();
const getGcsObjectStream = jest.fn();

jest.mock('@/lib/aws/s3-client', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentToS3(...args),
  getObjectStream: (...args: unknown[]) => getS3ObjectStream(...args),
}));

jest.mock('@/lib/gcp/gcs-client', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentToGcs(...args),
  getObjectStream: (...args: unknown[]) => getGcsObjectStream(...args),
}));

jest.mock('@/lib/utils/uuid', () => ({
  generateUUID: () => 'uuid-123',
}));

import { Readable } from 'node:stream';
import { getAttachmentFromS3, storeAttachmentInS3 } from '../attachment-storage-service';

describe('attachment-storage-service', () => {
  beforeEach(() => {
    delete process.env.STORAGE_PROVIDER;
    uploadDocumentToS3.mockReset();
    getS3ObjectStream.mockReset();
    uploadDocumentToGcs.mockReset();
    getGcsObjectStream.mockReset();
  });

  it('uses S3 by default', async () => {
    uploadDocumentToS3.mockResolvedValue({
      key: 'conversations/123-attachment.json',
      url: 'https://example.com/s3',
    });

    const result = await storeAttachmentInS3('conv-1', 'msg-1', {
      type: 'file',
      name: 'notes.txt',
      data: 'hello',
      contentType: 'text/plain',
    }, 0);

    expect(uploadDocumentToS3).toHaveBeenCalledTimes(1);
    expect(uploadDocumentToGcs).not.toHaveBeenCalled();
    expect(uploadDocumentToS3).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'conversations',
      contentType: 'application/json',
      metadata: expect.objectContaining({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        attachmentType: 'file',
      }),
    }));
    expect(result.s3Key).toBe('conversations/123-attachment.json');
  });

  it('uses GCS when STORAGE_PROVIDER=gcs', async () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    uploadDocumentToGcs.mockResolvedValue({
      key: 'conversations/456-attachment.json',
      url: 'https://example.com/gcs',
    });

    const result = await storeAttachmentInS3('conv-2', 'msg-2', {
      type: 'image',
      name: 'diagram.png',
      image: 'base64data',
      contentType: 'image/png',
    }, 1);

    expect(uploadDocumentToGcs).toHaveBeenCalledTimes(1);
    expect(uploadDocumentToS3).not.toHaveBeenCalled();
    expect(result.s3Key).toBe('conversations/456-attachment.json');
  });

  it('reads attachments from the configured provider', async () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    const stream = Readable.from([JSON.stringify({ type: 'file', data: 'hello' })]);
    getGcsObjectStream.mockResolvedValue({ stream });

    await expect(getAttachmentFromS3('conversations/456-attachment.json')).resolves.toEqual({
      type: 'file',
      data: 'hello',
    });

    expect(getGcsObjectStream).toHaveBeenCalledWith('conversations/456-attachment.json');
    expect(getS3ObjectStream).not.toHaveBeenCalled();
  });
});
