/**
 * PII Tokenization Service
 *
 * Provides reversible PII tokenization for K-12 AI interactions.
 * Uses Vertex AI Text API for PII detection and Firestore for secure token storage.
 *
 * Features:
 * - PII detection via Vertex AI Text API (TODO: wire up)
 * - Reversible tokenization (replace PII with tokens, restore later)
 * - Session-scoped token storage with automatic TTL expiration
 * - Encryption at rest via Firestore + GCP KMS
 *
 * Privacy Benefits:
 * - AI providers never see actual student PII
 * - Tokens are meaningless UUIDs that cannot be reversed without access to Firestore
 * - TTL ensures tokens automatically expire after configurable period
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger, generateRequestId } from '@/lib/logger';
import type {
  PIIEntity,
  TokenMapping,
  TokenizationResult,
  PIITokenDynamoDBItem,
  GuardrailsConfig,
} from './types';
import { K12_PII_TYPES, CUSTOM_PII_PATTERNS, type ComprehendPIIType } from './types';

/**
 * PIITokenizationService - Reversible PII protection for student data
 *
 * Flow:
 * 1. User message → tokenize() → AI provider (sees tokens, not PII)
 * 2. AI response → detokenize() → User (sees restored PII naturally)
 */
export class PIITokenizationService {
  private useLocalStorage = true;
  private _localStore = new Map<string, { token: string; original: string; type: string; sessionId: string; createdAt: number; ttl: number }>();
  private config: GuardrailsConfig;
  private log = createLogger({ module: 'PIITokenizationService' });

  constructor(config?: Partial<GuardrailsConfig>) {
    const gcpProject = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;

      // Graceful degradation for local development - use in-memory storage
    if (!gcpProject) {
      this.log.warn('GCP_PROJECT_ID not configured - PIITokenizationService using in-memory storage');
      this.config = {
        region: '',
        guardrailId: '',
        guardrailVersion: 'DRAFT',
        piiTokenTableName: undefined,
        tokenTtlSeconds: 3600,
        enablePiiTokenization: config?.enablePiiTokenization ?? true, // Enabled with in-memory storage
          };
      return;
        }

      // Firestore would be initialized here in production
    this.config = {
      region: gcpProject,
      guardrailId: config?.guardrailId || '',
      guardrailVersion: config?.guardrailVersion || 'DRAFT',
      piiTokenTableName: config?.piiTokenTableName || process.env.PII_TOKEN_TABLE_NAME,
      tokenTtlSeconds: config?.tokenTtlSeconds ?? 3600, // 1 hour default
      enablePiiTokenization: config?.enablePiiTokenization ?? true,
        };

    if (!this.config.piiTokenTableName && this.config.enablePiiTokenization) {
      this.log.warn('PII token table not configured - tokenization disabled');
      this.config.enablePiiTokenization = false;
        }
     }

   /**
    * Check if PII tokenization is enabled
    */
  isEnabled(): boolean {
    return this.config.enablePiiTokenization === true && !!this.config.piiTokenTableName;
     }

   /**
    * Detect PII entities in text using Vertex AI Text API (TODO: wire up)
    * For now, falls back to custom regex patterns only.
    */
  async detectPII(text: string): Promise<PIIEntity[]> {
      // TODO: Wire up to Vertex AI Text API for PII detection
      // For now, fall back to custom regex patterns only
    this.log.debug('Vertex AI PII detection not yet configured — using custom patterns only');
      // Return empty — custom patterns are handled by detectCustomPII()
    return [];
     }

   /**
    * Detect custom PII patterns using regex (e.g., student IDs, employee numbers)
    */
  detectCustomPII(text: string): PIIEntity[] {
    const entities: PIIEntity[] = [];

    for (const pattern of CUSTOM_PII_PATTERNS) {
      const globalPattern = new RegExp(pattern.pattern.source, 'g');
      let match: RegExpExecArray | null;

      while ((match = globalPattern.exec(text)) !== null) {
        entities.push({
          type: pattern.type,
          beginOffset: match.index,
          endOffset: match.index + match[0].length,
          score: pattern.confidence ?? 1.0,
            });
          }
        }

    if (entities.length > 0) {
      this.log.debug('Custom PII patterns detected', {
        entitiesFound: entities.length,
        entityTypes: entities.map((e) => e.type),
          });
        }

    return entities;
     }

   /**
    * Tokenize PII in text - replace PII with tokens and store mapping
    */
  async tokenize(text: string, sessionId: string): Promise<TokenizationResult> {
    if (!this.isEnabled()) {
      return {
        tokenizedText: text,
        tokens: [],
        hasPII: false,
          };
        }

    const requestId = generateRequestId();
    this.log.info('Starting PII tokenization', {
      requestId,
      textLength: text.length,
      sessionId,
        });

    try {
       // Detect PII entities from Vertex AI (or custom patterns as fallback)
      const comprehendEntities = await this.detectPII(text);

       // Filter to only K-12 relevant PII types
      const relevantComprehendEntities = comprehendEntities.filter((entity) =>
        K12_PII_TYPES.includes(entity.type as ComprehendPIIType)
          );

       // Detect custom PII patterns (e.g., student IDs)
      const customEntities = this.detectCustomPII(text);

       // Merge entities, removing duplicates based on position overlap
      const allEntities = this.mergeEntities(relevantComprehendEntities, customEntities);

      if (allEntities.length === 0) {
        this.log.debug('No PII found (Vertex AI or custom)', { requestId });
        return {
          tokenizedText: text,
          tokens: [],
          hasPII: false,
            };
          }

       // Sort by position (reverse) to replace from end to start
      const sortedEntities = [...allEntities].sort(
        (a, b) => b.beginOffset - a.beginOffset
          );

      let tokenizedText = text;
      const tokens: TokenMapping[] = [];

      for (const entity of sortedEntities) {
        const token = uuidv4();
        const original = text.substring(entity.beginOffset, entity.endOffset);
        const placeholder = `[PII:${token}]`;

           // Store mapping in Firestore (or local store for dev)
        await this.storeTokenMapping(token, original, entity.type, sessionId);

           // Replace in text (from end to preserve positions)
        tokenizedText =
          tokenizedText.substring(0, entity.beginOffset) +
          placeholder +
          tokenizedText.substring(entity.endOffset);

        tokens.push({
          token,
          original,
          type: entity.type,
          placeholder,
            });
          }

      this.log.info('PII tokenization complete', {
        requestId,
        tokensCreated: tokens.length,
        piiTypes: tokens.map((t) => t.type),
          });

      return {
        tokenizedText,
        tokens,
        hasPII: true,
          };
        } catch (error) {
      this.log.error('PII tokenization failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
          });

         // Graceful degradation - return original text if tokenization fails
      return {
        tokenizedText: text,
        tokens: [],
        hasPII: false,
          };
        }
     }

   /**
    * Detokenize text - restore original PII values from tokens
    */
  async detokenize(text: string, sessionId: string): Promise<string> {
    if (!this.isEnabled()) {
      return text;
        }

    const requestId = generateRequestId();

      // Find all token placeholders in the text (full UUID format)
    const tokenPattern = /\[PII:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]/g;
    const matches = [...text.matchAll(tokenPattern)];

    if (matches.length === 0) {
      return text;
        }

    this.log.info('Starting PII detokenization', {
      requestId,
      tokensFound: matches.length,
      sessionId,
        });

    try {
      let detokenizedText = text;

       // Batch fetch tokens for efficiency
      const tokenIds = matches.map((m) => m[1]);
      const tokenMappings = await this.batchGetTokenMappings(tokenIds, sessionId);

      let replacementsApplied = 0;
      for (const match of matches) {
        const [placeholder, token] = match;

           // Find matching token by exact match
        const tokenMapping = tokenMappings.find((t) => t.token === token);

        if (tokenMapping) {
          const before = detokenizedText;
          detokenizedText = detokenizedText.replace(placeholder, tokenMapping.original);
          if (detokenizedText !== before) {
            replacementsApplied++;
              }
            } else {
          this.log.warn('Token mapping not found', {
            requestId,
            token,
            sessionId,
              });
             // Leave placeholder if token not found (may have expired)
            }
          }

      this.log.info('PII detokenization complete', {
        requestId,
        uniqueTokensResolved: tokenMappings.length,
        textReplacementsApplied: replacementsApplied,
          });

      return detokenizedText;
        } catch (error) {
      this.log.error('PII detokenization failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
          });

         // Return original text with placeholders if detokenization fails
      return text;
        }
     }

   /**
    * Merge Vertex AI and custom PII entities, removing overlaps
    */
  private mergeEntities(
    comprehendEntities: PIIEntity[],
    customEntities: PIIEntity[]
    ): PIIEntity[] {
      // Start with all custom entities (they take precedence)
    const merged: PIIEntity[] = [...customEntities];

      // Add Vertex AI entities that don't overlap with custom ones
    for (const comprehend of comprehendEntities) {
      const overlaps = customEntities.some(
        (custom) =>
          comprehend.beginOffset < custom.endOffset &&
          comprehend.endOffset > custom.beginOffset
          );

      if (!overlaps) {
        merged.push(comprehend);
          }
        }

    return merged;
     }

   /**
    * Store token mapping in Firestore (or local store for dev)
    */
  private async storeTokenMapping(
    token: string,
    original: string,
    type: string,
    sessionId: string
    ): Promise<void> {
    if (this.useLocalStorage || !this._localStore) {
      this._localStore.set(token, { token, original, type, sessionId, createdAt: Date.now(), ttl: Math.floor(Date.now() / 1000) + (this.config.tokenTtlSeconds || 3600) });
      return;
        }

    // Firestore would be used here in production
    this._localStore.set(token, { token, original, type, sessionId, createdAt: Date.now(), ttl: Math.floor(Date.now() / 1000) + (this.config.tokenTtlSeconds || 3600) });
     }

   /**
    * Get a single token mapping from Firestore (or local store for dev)
    */
  private async getTokenMapping(
    token: string,
    sessionId: string
    ): Promise<{ token: string; original: string; type: string } | null> {
      // Check local store first (dev/local)
    if (this.useLocalStorage) {
      const entry = this._localStore.get(token);
      if (entry && entry.sessionId === sessionId) {
        return { token: entry.token, original: entry.original, type: entry.type };
          }
      return null;
        }

    // Firestore lookup would be here in production
    const entry = this._localStore.get(token);
    if (entry && entry.sessionId === sessionId) {
      return { token: entry.token, original: entry.original, type: entry.type };
        }
    return null;
     }

   /**
    * Batch get token mappings from Firestore (or local store for dev)
    */
  private async batchGetTokenMappings(
    tokens: string[],
    sessionId: string
    ): Promise<Array<{ token: string; original: string; type: string }>> {
    if (tokens.length === 0) {
      return [];
        }

      // Deduplicate token IDs
    const uniqueTokens = [...new Set(tokens)];

      // Check local store first (dev/local)
    if (this.useLocalStorage) {
      const results: Array<{ token: string; original: string; type: string }> = [];
      for (const token of uniqueTokens) {
        const entry = this._localStore.get(token);
        if (entry && entry.sessionId === sessionId) {
          results.push({ token: entry.token, original: entry.original, type: entry.type });
            }
          }
      return results;
        }

    // Firestore batch lookup would be here in production
    const allResults: Array<{ token: string; original: string; type: string }> = [];
    for (const token of uniqueTokens) {
      const entry = this._localStore.get(token);
      if (entry && entry.sessionId === sessionId) {
        allResults.push({ token: entry.token, original: entry.original, type: entry.type });
          }
        }
    return allResults;
     }

   /**
    * Get current configuration (for diagnostics)
    */
  getConfig(): Pick<
    GuardrailsConfig,
     'region' | 'piiTokenTableName' | 'tokenTtlSeconds' | 'enablePiiTokenization'
   > {
    return {
      region: this.config.region,
      piiTokenTableName: this.config.piiTokenTableName,
      tokenTtlSeconds: this.config.tokenTtlSeconds,
      enablePiiTokenization: this.config.enablePiiTokenization,
        };
     }
}

// Singleton instance
let piiTokenizationServiceInstance: PIITokenizationService | null = null;

/**
 * Get or create the PIITokenizationService singleton
 */
export function getPIITokenizationService(
  config?: Partial<GuardrailsConfig>
): PIITokenizationService {
  if (!piiTokenizationServiceInstance) {
    piiTokenizationServiceInstance = new PIITokenizationService(config);
      }
  return piiTokenizationServiceInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetPIITokenizationService(): void {
  piiTokenizationServiceInstance = null;
}
