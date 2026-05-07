import { createVertex } from '@ai-sdk/google-vertex';
import type { ToolSet } from 'ai';
import { createLogger } from '@/lib/logger';
import { ErrorFactories } from '@/lib/error-utils';
import { BaseProviderAdapter } from './base-adapter';
import type { StreamingCallbacks } from '../types';
import type { ProviderCapabilities, StreamRequest } from '../types';

const log = createLogger({ module: 'vertex-adapter' });

/**
 * Google Vertex AI provider adapter.
 *
 * Differs from GeminiAdapter (which uses @ai-sdk/google + Generative Language API
 * key) by authenticating via Google Cloud Application Default Credentials (ADC)
 * and running against Vertex AI regional endpoints. This is the "app running on
 * GCP" path — no API key required in the app; `gcloud auth application-default
 * login` locally or service-account credentials on the Cloud Run workload.
 *
 * Env vars consumed by the underlying SDK / this adapter:
 *   GOOGLE_CLOUD_PROJECT    — GCP project id (required for ADC mode)
 *   GOOGLE_VERTEX_LOCATION  — region, e.g. us-central1 (defaults to us-central1)
 *   GOOGLE_APPLICATION_CREDENTIALS — optional path to service account JSON
 */
export class VertexAdapter extends BaseProviderAdapter {
  protected providerName = 'google-vertex';
  private vertexClient?: ReturnType<typeof createVertex>;

  async createModel(modelId: string) {
    try {
      const project = process.env.GOOGLE_CLOUD_PROJECT;
      const location = process.env.GOOGLE_VERTEX_LOCATION || 'us-central1';

      if (!project) {
        log.error('GOOGLE_CLOUD_PROJECT env var not set');
        throw ErrorFactories.sysConfigurationError(
          'GOOGLE_CLOUD_PROJECT env var is required for Vertex AI provider'
        );
      }

      log.debug(`Creating Vertex model: ${modelId}`, { modelId, project, location });

      // createVertex will use Application Default Credentials by default.
      // Locally: `gcloud auth application-default login`.
      // On GCP: automatic via the workload identity / attached service account.
      this.vertexClient = createVertex({ project, location });
      this.providerClient = this.vertexClient;

      return this.vertexClient(modelId);
    } catch (error) {
      log.error('Failed to create Vertex model', {
        modelId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Vertex / Gemini-native tools. Keep narrow for the demo vertical slice —
   * universal tools from the base class still work.
   */
  async createTools(enabledTools: string[]): Promise<ToolSet> {
    const universalTools = await super.createTools(enabledTools);
    return universalTools as ToolSet;
  }

  getSupportedTools(_modelId: string): string[] {
    // Keep minimal — the demo path doesn't need provider-native tools.
    return [];
  }

  getCapabilities(modelId: string): ProviderCapabilities {
    // Claude 4 on Vertex Anthropic publisher models
    if (this.matchesPattern(modelId, ['claude-4*', 'anthropic.claude-4*', 'claude-sonnet-4*', 'publishers/anthropic/models/claude-*4*'])) {
      return {
        supportsReasoning: true,
        supportsThinking: true,
        maxThinkingTokens: 6553,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 3000,
        maxTimeoutMs: 120000,
        costPerInputToken: 0.000015,
        costPerOutputToken: 0.000075
      };
    }

    // Claude 3.x / 3.5 on Vertex Anthropic publisher models
    if (this.matchesPattern(modelId, ['claude-3*', 'claude-3-5*', 'anthropic.claude-3*', 'publishers/anthropic/models/claude-*'])) {
      const isOpus = this.matchesPattern(modelId, ['*opus*']);
      const isHaiku = this.matchesPattern(modelId, ['*haiku*']);

      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: isHaiku ? 1000 : isOpus ? 3000 : 2000,
        maxTimeoutMs: 60000,
        costPerInputToken: isOpus ? 0.000015 : isHaiku ? 0.00000025 : 0.000003,
        costPerOutputToken: isOpus ? 0.000075 : isHaiku ? 0.00000125 : 0.000015
      };
    }

    // Gemini 2.5 via Vertex (reasoning-capable)
    if (this.matchesPattern(modelId, ['gemini-2.5*'])) {
      return {
        supportsReasoning: true,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 2500,
        maxTimeoutMs: 90000,
        costPerInputToken: 0.000002,
        costPerOutputToken: 0.000008
      };
    }

    // Gemini 2.0 Flash on Vertex
    if (this.matchesPattern(modelId, ['gemini-2.0-flash*', 'gemini-2.0*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 900,
        maxTimeoutMs: 45000,
        costPerInputToken: 0.00000015,
        costPerOutputToken: 0.0000006
      };
    }

    // Gemini 1.5 Pro
    if (this.matchesPattern(modelId, ['gemini-1.5-pro*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 2000,
        maxTimeoutMs: 60000,
        costPerInputToken: 0.00000125,
        costPerOutputToken: 0.000005
      };
    }

    // Gemini 1.5 Flash
    if (this.matchesPattern(modelId, ['gemini-1.5-flash*'])) {
      return {
        supportsReasoning: false,
        supportsThinking: false,
        supportedResponseModes: ['standard'],
        supportsBackgroundMode: false,
        supportedTools: [],
        typicalLatencyMs: 1000,
        maxTimeoutMs: 30000,
        costPerInputToken: 0.000000075,
        costPerOutputToken: 0.0000003
      };
    }

    return this.getDefaultCapabilities();
  }

  getProviderOptions(modelId: string, options?: StreamRequest['options']): Record<string, unknown> {
    return super.getProviderOptions(modelId, options);
  }

  supportsModel(modelId: string): boolean {
    const supportedPatterns = [
      'gemini-*',
      'models/gemini-*',
      'gemini-1.5*',
      'gemini-2.0*',
      'gemini-2.5*',
      'claude-*',
      'anthropic.claude-*',
      'publishers/anthropic/models/claude-*'
    ];
    return this.matchesPattern(modelId, supportedPatterns);
  }

  protected handleError(error: Error, callbacks: StreamingCallbacks): void {
    super.handleError(error, callbacks);

    // Vertex-specific error hints
    if (error.message.includes('PERMISSION_DENIED') || error.message.includes('IAM')) {
      log.warn('Vertex AI permission denied — check service account roles', {
        error: error.message
      });
    }
    if (error.message.includes('SAFETY')) {
      log.warn('Vertex safety filter triggered', { error: error.message });
    }
    if (error.message.includes('QUOTA')) {
      log.warn('Vertex quota exceeded', { error: error.message });
    }
  }
}
