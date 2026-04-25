/**
 * GCS Client tests — migrated from S3 client tests (Slice E2).
 *
 * Tests the public surface of `lib/gcp/gcs-client.ts` using mocked
 * `@google-cloud/storage`. The test names and structure mirror the original
 * S3 tests for easy comparison.
 */

import { 
  uploadDocument, 
  getDocumentSignedUrl, 
  deleteDocument,
  documentExists,
  listUserDocuments,
  extractKeyFromUrl
} from '@/lib/gcp/gcs-client';
import { Storage, Bucket, File } from '@google-cloud/storage';

// Mock GCS SDK and config
jest.mock('@google-cloud/storage');
jest.mock('@/lib/settings-manager', () => ({
  Settings: {
    getS3: jest.fn().mockResolvedValue({
      bucket: 'test-bucket',
      region: 'us-east-1'
     })
   }
}));

describe('GCS Client', () => {
  const mockBucket = {
    exists: jest.fn(),
    file: jest.fn(),
    getFiles: jest.fn(),
  };
  
  const mockFile = {
    save: jest.fn(),
    delete: jest.fn(),
    getMetadata: jest.fn(),
    createReadStream: jest.fn(),
    getSignedUrl: jest.fn(),
    createResumableUpload: jest.fn(),
  };

  const mockStorage = {
    bucket: jest.fn(() => mockBucket),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
     // Bucket exists check
    mockBucket.exists.mockResolvedValue([true]);
    
     // file() returns the mock file
    mockBucket.file.mockReturnValue(mockFile);
    
     // Storage.bucket() returns the mock bucket
    (Storage as unknown as jest.Mock).mockImplementation(() => mockStorage);
    
     // Signed URL returns a test URL
    mockFile.getSignedUrl.mockResolvedValue([
      'https://storage.googleapis.com/test-bucket/test-key?signature=test'
    ]);
  });

  describe('uploadDocument', () => {
    it('should upload a document successfully', async () => {
      const params = {
        userId: 'user-123',
        fileName: 'test.pdf',
        fileContent: Buffer.from('test content'),
        contentType: 'application/pdf',
        metadata: { originalName: 'test.pdf' },
       };

      mockFile.save.mockResolvedValue(undefined);

      const result = await uploadDocument(params);

      expect(result).toEqual({
        key: expect.stringMatching(/^user-123\/\d+-test\.pdf$/),
        url: expect.stringContaining('storage.googleapis.com'),
       });

      expect(mockBucket.file).toHaveBeenCalledWith(
        expect.stringMatching(/^user-123\/\d+-test\.pdf$/)
       );
      expect(mockFile.save).toHaveBeenCalled();
     });

    it('should handle upload errors', async () => {
      const params = {
        userId: 'user-123',
        fileName: 'test.pdf',
        fileContent: Buffer.from('test content'),
        contentType: 'application/pdf',
       };

      mockFile.save.mockRejectedValue(new Error('GCS Upload Error'));

      await expect(uploadDocument(params)).rejects.toThrow('Failed to upload document');
     });

    it('should include custom metadata', async () => {
      const params = {
        userId: 'user-123',
        fileName: 'test.pdf',
        fileContent: Buffer.from('test content'),
        contentType: 'application/pdf',
        metadata: {
          category: 'reports',
          tags: 'financial,quarterly',
         },
       };

      mockFile.save.mockResolvedValue(undefined);

      await uploadDocument(params);

      expect(mockFile.save).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          metadata: expect.objectContaining({
            category: 'reports',
            tags: 'financial,quarterly',
           }),
         })
       );
     });
   });

  describe('deleteDocument', () => {
    it('should delete a document successfully', async () => {
      const key = 'documents/user-123/test.pdf';

      mockFile.delete.mockResolvedValue(undefined);

      await deleteDocument(key);

      expect(mockBucket.file).toHaveBeenCalledWith(key);
      expect(mockFile.delete).toHaveBeenCalled();
     });

    it('should handle deletion errors', async () => {
      const key = 'documents/user-123/test.pdf';

      mockFile.delete.mockRejectedValue(new Error('GCS Error'));

      await expect(deleteDocument(key)).rejects.toThrow('Failed to delete document');
     });
   });

  describe('getDocumentSignedUrl', () => {
    it('should generate a signed URL for download', async () => {
      const mockUrl = 'https://storage.googleapis.com/bucket/documents/user-123/test.pdf?signature=xyz';

      mockFile.getSignedUrl.mockResolvedValue([mockUrl]);

      const result = await getDocumentSignedUrl({ 
        key: 'documents/user-123/test.pdf' 
       });

      expect(result).toBe(mockUrl);
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresIn: 3600,
         })
       );
     });

    it('should generate a signed URL with custom expiration', async () => {
      const mockUrl = 'https://storage.googleapis.com/bucket/documents/user-123/test.pdf?signature=xyz';

      mockFile.getSignedUrl.mockResolvedValue([mockUrl]);

      const result = await getDocumentSignedUrl({ 
        key: 'documents/user-123/test.pdf',
        expiresIn: 7200
       });

      expect(result).toBe(mockUrl);
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresIn: 7200,
         })
       );
     });

    it('should handle signed URL generation errors', async () => {
      mockFile.getSignedUrl.mockRejectedValue(new Error('GCS Error'));

      await expect(getDocumentSignedUrl({ 
        key: 'documents/user-123/test.pdf' 
       })).rejects.toThrow('Failed to generate signed URL');
     });
   });

  describe('documentExists', () => {
    it('should return true if document exists', async () => {
      mockBucket.exists.mockResolvedValue([true]);

      const result = await documentExists('documents/user-123/test.pdf');

      expect(result).toBe(true);
      expect(mockBucket.file).toHaveBeenCalledWith('documents/user-123/test.pdf');
     });

    it('should return false if document does not exist', async () => {
      mockBucket.exists.mockResolvedValue([false]);

      const result = await documentExists('documents/user-123/test.pdf');

      expect(result).toBe(false);
     });
   });

  describe('listUserDocuments', () => {
    it('should list user documents', async () => {
      mockBucket.getFiles.mockResolvedValue([
        [
          { name: 'documents/user-123/file1.pdf', metadata: { size: '1000', updated: new Date().toISOString() } },
          { name: 'documents/user-123/file2.pdf', metadata: { size: '2000', updated: new Date().toISOString() } },
         ]
       ]);

      const result = await listUserDocuments('user-123');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        key: 'documents/user-123/file1.pdf',
        size: 1000,
        lastModified: expect.any(Date)
       });
     });
   });

  describe('Key Generation', () => {
    it('should generate unique keys for same filename', async () => {
      const params = {
        userId: 'user-123',
        fileName: 'test.pdf',
        fileContent: Buffer.from('test content'),
        contentType: 'application/pdf',
       };

      mockFile.save.mockResolvedValue(undefined);

      const result1 = await uploadDocument(params);
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      const result2 = await uploadDocument(params);

      expect(result1.key).not.toBe(result2.key);
      expect(result1.key).toMatch(/^user-123\/\d+-test\.pdf$/);
      expect(result2.key).toMatch(/^user-123\/\d+-test\.pdf$/);
     });

    it('should preserve file extensions', async () => {
      const testCases = [
        { fileName: 'test.pdf', expectedExt: '.pdf' },
        { fileName: 'report.docx', expectedExt: '.docx' },
        { fileName: 'data.txt', expectedExt: '.txt' },
        { fileName: 'no-extension', expectedExt: '' },
       ];

      mockFile.save.mockResolvedValue(undefined);

      for (const testCase of testCases) {
        const result = await uploadDocument({
          userId: 'user-123',
          fileName: testCase.fileName,
          fileContent: Buffer.from('test'),
          contentType: 'application/octet-stream',
         });

        if (testCase.expectedExt) {
          expect(result.key).toMatch(new RegExp(`${testCase.expectedExt}$`));
         } else {
          expect(result.key).toMatch(/^user-123\/\d+-no-extension$/);
         }
       }
     });
   });

  describe('extractKeyFromUrl', () => {
    it('should extract key from storage.googleapis.com URL', async () => {
      const key = await extractKeyFromUrl(
        'https://storage.googleapis.com/test-bucket/documents/user-123/test.pdf'
      );
      expect(key).toBe('documents/user-123/test.pdf');
     });

    it('should extract key from gs:// URL', async () => {
      const key = await extractKeyFromUrl('gs://test-bucket/documents/user-123/test.pdf');
      expect(key).toBe('documents/user-123/test.pdf');
     });

    it('should return null for unknown bucket URLs', async () => {
      const key = await extractKeyFromUrl(
        'https://storage.googleapis.com/other-bucket/documents/user-123/test.pdf'
      );
      expect(key).toBeNull();
     });
   });
});
