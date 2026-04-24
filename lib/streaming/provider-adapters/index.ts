import { createLogger } from '@/lib/logger';
import type { ProviderAdapter, ProviderCapabilities } from '../types';
import { OpenAIAdapter } from './openai-adapter';
import { ClaudeAdapter } from './claude-adapter';
import { GeminiAdapter } from './gemini-adapter';
import { AzureAdapter } from './azure-adapter';
import { LatimerAdapter } from './latimer-adapter';
import { VertexAdapter } from './vertex-adapter';

const log = createLogger({ module: 'provider-adapters' });
const VERTEX_TRANSITION_PROVIDERS = new Set(['amazon-bedrock', 'google']);

// Registry of all available provider adapters
const adapters = new Map<string, ProviderAdapter>([
  ['openai', new OpenAIAdapter()],
  ['amazon-bedrock', new ClaudeAdapter()],
  ['google', new GeminiAdapter()],
  ['google-vertex', new VertexAdapter()],
  ['azure', new AzureAdapter()],
  ['latimer', new LatimerAdapter()]
]);

function resolveProvider(provider: string): string {
  const normalizedProvider = provider.toLowerCase();

  if (process.env.VERTEX_AI_ENABLED === 'true' && VERTEX_TRANSITION_PROVIDERS.has(normalizedProvider)) {
    return 'google-vertex';
  }

  return normalizedProvider;
}

/**
 * Get the appropriate provider adapter for the given provider
 */
export async function getProviderAdapter(provider: string): Promise<ProviderAdapter> {
  const resolvedProvider = resolveProvider(provider);
  const adapter = adapters.get(resolvedProvider);
  
  if (!adapter) {
    log.error('Unknown provider', { provider, resolvedProvider });
    throw new Error(`Unknown provider: ${provider}`);
  }
  
  return adapter;
}

/**
 * Get capabilities for a specific model across all providers
 */
export async function getModelCapabilities(provider: string, modelId: string): Promise<ProviderCapabilities> {
  const adapter = await getProviderAdapter(provider);
  return adapter.getCapabilities(modelId);
}

/**
 * Check if a model is supported by any provider
 */
export async function isModelSupported(provider: string, modelId: string): Promise<boolean> {
  try {
    const adapter = await getProviderAdapter(provider);
    return adapter.supportsModel(modelId);
  } catch {
    return false;
  }
}

/**
 * Get list of all supported providers
 */
export function getSupportedProviders(): string[] {
  return Array.from(adapters.keys());
}

// Re-export types and base classes
export type { ProviderAdapter, ProviderCapabilities } from '../types';
export { BaseProviderAdapter } from './base-adapter';