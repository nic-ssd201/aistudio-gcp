/**
 * Tests for PIITokenizationService
 *
 * Focuses on core functionality and token lifecycle.
 */

import { PIITokenizationService } from '../pii-tokenization-service';

// Mock AWS SDK client (the comprehend dep is still in package.json; the
// dynamodb mock was removed alongside @aws-sdk/client-dynamodb in PR C
// since neither this test nor production code actually exercises it —
// the imports + dead MockBatchGetItemInput interface were stale scaffolding).
jest.mock('@aws-sdk/client-comprehend');

describe('PIITokenizationService', () => {
  let service: PIITokenizationService;
  const TEST_REGION = 'us-west-2';

  beforeEach(() => {
    service = new PIITokenizationService({
      region: TEST_REGION,
      piiTokenTableName: 'test-table',
      tokenTtlSeconds: 3600,
      enablePiiTokenization: true,
    });
  });

  describe('isEnabled', () => {
    it('should return true when configured', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when not configured', () => {
      const disabledService = new PIITokenizationService({
        region: TEST_REGION,
        piiTokenTableName: undefined,
        enablePiiTokenization: false,
      });
      expect(disabledService.isEnabled()).toBe(false);
    });
  });

  describe('tokenize', () => {
    it('should pass through content when disabled', async () => {
      const disabledService = new PIITokenizationService({
        region: TEST_REGION,
        enablePiiTokenization: false,
      });

      const result = await disabledService.tokenize('Hello John', 'session-123');

      expect(result.tokenizedText).toBe('Hello John');
      expect(result.hasPII).toBe(false);
      expect(result.tokens).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      // Mock implementation will throw by default since AWS clients are mocked
      const result = await service.tokenize('Hello John', 'session-123');

      expect(result.tokenizedText).toBe('Hello John');
      expect(result.hasPII).toBe(false);
      expect(result.tokens).toEqual([]);
    });
  });

  describe('detokenize', () => {
    it('should pass through content when disabled', async () => {
      const disabledService = new PIITokenizationService({
        region: TEST_REGION,
        enablePiiTokenization: false,
      });

      const result = await disabledService.detokenize(
        '[PII:abc123]',
        'session-123'
      );

      expect(result).toBe('[PII:abc123]');
    });

    it('should handle missing tokens gracefully', async () => {
      // Mock implementation will throw by default since AWS clients are mocked
      const result = await service.detokenize(
        '[PII:12345678-1234-1234-1234-123456789012]',
        'session-123'
      );

      // Should return original text with placeholder when token not found
      expect(result).toContain('[PII:');
    });
  });

  describe('getConfig', () => {
    it('should return configuration', () => {
      const config = service.getConfig();

      expect(config).toHaveProperty('region');
      expect(config).toHaveProperty('piiTokenTableName');
      expect(config).toHaveProperty('tokenTtlSeconds');
      expect(config).toHaveProperty('enablePiiTokenization');
      expect(config.piiTokenTableName).toBe('test-table');
      expect(config.tokenTtlSeconds).toBe(3600);
    });
  });

  describe('edge cases', () => {
    it('should enable service with in-memory storage when region not configured but config provided', () => {
        // Save and clear env var
      const originalRegion = process.env.AWS_REGION;
      delete process.env.AWS_REGION;

        // Should be enabled with in-memory storage when config is explicitly provided
      const localService = new PIITokenizationService({
        piiTokenTableName: 'test-table',
        enablePiiTokenization: true,
          // No region provided — uses in-memory store
        });

        // Service should be enabled (uses in-memory storage with provided config)
      expect(localService.isEnabled()).toBe(true);

        // Restore env var
      if (originalRegion) {
        process.env.AWS_REGION = originalRegion;
        }
      });


    it('should handle empty string content', async () => {
      const result = await service.tokenize('', 'session-123');
      expect(result.tokenizedText).toBe('');
      expect(result.hasPII).toBe(false);
      expect(result.tokens).toEqual([]);
    });

    it('should handle whitespace-only content', async () => {
      const result = await service.tokenize('   \n\t  ', 'session-123');
      expect(result.tokenizedText).toBe('   \n\t  ');
      expect(result.hasPII).toBe(false);
    });

    it('should handle very long content without hanging', async () => {
      const longContent = 'Hello John '.repeat(10000);
      const result = await service.tokenize(longContent, 'session-123');
      // Graceful degradation when mocked - should not throw or hang
      expect(result.tokenizedText).toBe(longContent);
    });

    it('should handle detokenize with no placeholders', async () => {
      const result = await service.detokenize('No PII here', 'session-123');
      expect(result).toBe('No PII here');
    });

    it('should handle invalid token format gracefully', async () => {
      // Not a valid UUID format - should be left as-is
      const result = await service.detokenize('[PII:invalid]', 'session-123');
      expect(result).toBe('[PII:invalid]');
    });
  });

  describe('duplicate token deduplication (Issue #836)', () => {
    const TOKEN_UUID = '12345678-1234-1234-1234-123456789012';
    const PLACEHOLDER = `[PII:${TOKEN_UUID}]`;

    // Helper to populate the service's local store for testing
    function populateLocalStore(entries: Array<{ token: string; original: string; type: string; sessionId: string }>) {
      for (const entry of entries) {
        (service as any)._localStore.set(entry.token, {
          token: entry.token,
          original: entry.original,
          type: entry.type,
          sessionId: entry.sessionId,
          createdAt: Date.now(),
          ttl: 3600,
        });
      }
    }

    beforeEach(() => {
      // Clear local store before each test
      (service as any)._localStore.clear();
    });

    it('should deduplicate token IDs before batch lookup', async () => {
      // Text with the same PII token appearing 3 times
      const text = `Hello ${PLACEHOLDER}, as ${PLACEHOLDER} mentioned, ${PLACEHOLDER} is correct.`;

      populateLocalStore([
        { token: TOKEN_UUID, original: 'John', type: 'NAME', sessionId: 'session-123' },
      ]);

      const result = await service.detokenize(text, 'session-123');

       // All 3 occurrences should still be replaced
      expect(result).toBe('Hello John, as John mentioned, John is correct.');
     });

    it('should handle all-duplicate tokens as a single lookup', async () => {
      const text = `${PLACEHOLDER} ${PLACEHOLDER}`;

      populateLocalStore([
        { token: TOKEN_UUID, original: 'Jane', type: 'NAME', sessionId: 'session-123' },
      ]);

      const result = await service.detokenize(text, 'session-123');

      expect(result).toBe('Jane Jane');
     });

    it('should preserve unique tokens while deduplicating repeats', async () => {
      const TOKEN_A = '11111111-1111-1111-1111-111111111111';
      const TOKEN_B = '22222222-2222-2222-2222-222222222222';
       // A appears twice, B appears once → should look up both
      const text = `[PII:${TOKEN_A}] and [PII:${TOKEN_B}] met [PII:${TOKEN_A}]`;

      populateLocalStore([
        { token: TOKEN_A, original: 'Alice', type: 'NAME', sessionId: 'session-123' },
        { token: TOKEN_B, original: 'Bob', type: 'NAME', sessionId: 'session-123' },
      ]);

      const result = await service.detokenize(text, 'session-123');

      expect(result).toBe('Alice and Bob met Alice');
     });
   });
});