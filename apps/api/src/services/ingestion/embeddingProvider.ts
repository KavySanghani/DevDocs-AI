import crypto from 'node:crypto';
import type { ApiEnv } from '../../config/env.js';
import { type EmbeddingProvider, EmbeddingProviderError } from './types.js';

export interface MockEmbeddingProviderOptions {
  model?: string | undefined;
  dimensions?: number | undefined;
  simulatedDimension?: number | undefined;
  simulatedError?: string | null | undefined;
  simulatedDelayMs?: number | undefined;
}

/**
 * Deterministic mock embedding provider for tests and local development.
 * Produces unit-length (L2 normalized) vectors seeded deterministically by input text.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly simulatedDimension?: number | undefined;
  private readonly simulatedError?: string | null | undefined;
  private readonly simulatedDelayMs?: number | undefined;

  constructor(options: MockEmbeddingProviderOptions = {}) {
    this.model = options.model ?? 'mock-text-embedding-3-small';
    this.dimensions = options.dimensions ?? 1536;
    this.simulatedDimension = options.simulatedDimension;
    this.simulatedError = options.simulatedError;
    this.simulatedDelayMs = options.simulatedDelayMs;
  }

  async embedChunks(texts: string[]): Promise<number[][]> {
    if (this.simulatedDelayMs && this.simulatedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedDelayMs));
    }

    if (this.simulatedError) {
      throw new EmbeddingProviderError(
        `Mock embedding failure: ${this.simulatedError}`,
        'PROVIDER_ERROR'
      );
    }

    if (texts.length === 0) {
      return [];
    }

    const outputDims = this.simulatedDimension ?? this.dimensions;

    return texts.map((text) => this.generateDeterministicVector(text, outputDims));
  }

  private generateDeterministicVector(text: string, dims: number): number[] {
    const hash = crypto.createHash('sha256').update(text).digest();
    const vector: number[] = new Array(dims);

    // Use repeated SHA-256 rounds to seed deterministic pseudo-random numbers
    let currentHash = hash;
    let byteIdx = 0;
    let sumSq = 0;

    for (let i = 0; i < dims; i++) {
      if (byteIdx + 4 > currentHash.length) {
        currentHash = crypto.createHash('sha256').update(currentHash).digest();
        byteIdx = 0;
      }

      // Read 32-bit signed int normalized to [-1, 1]
      const intVal = currentHash.readInt32LE(byteIdx);
      byteIdx += 4;
      const floatVal = intVal / 2147483648;
      vector[i] = floatVal;
      sumSq += floatVal * floatVal;
    }

    // Normalize to unit vector (L2 norm) for cosine distance compatibility
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < dims; i++) {
      const val = vector[i] ?? 0;
      vector[i] = Number((val / norm).toFixed(7));
    }

    return vector;
  }
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model?: string | undefined;
  dimensions?: number | undefined;
  batchSize?: number | undefined;
  timeoutMs?: number | undefined;
  baseUrl?: string | undefined;
}

/**
 * OpenAI embedding provider using native Node 22 fetch.
 * Redacts secrets from errors and validates dimensionality and finite values.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new EmbeddingProviderError(
        'OpenAI API key must not be empty',
        'MISSING_API_KEY'
      );
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimensions = options.dimensions ?? 1536;
    this.batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 100;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30000;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  async embedChunks(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const allEmbeddings: number[][] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchVectors = await this.embedBatch(batch, i);
      allEmbeddings.push(...batchVectors);
    }

    return allEmbeddings;
  }

  private async embedBatch(batch: string[], offset: number): Promise<number[][]> {
    const endpoint = `${this.baseUrl}/embeddings`;
    const payload = {
      model: this.model,
      input: batch,
      dimensions: this.dimensions,
    };

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const isTimeout =
        (err instanceof Error && err.name === 'TimeoutError') ||
        (err instanceof Error && err.name === 'AbortError');
      if (isTimeout) {
        throw new EmbeddingProviderError(
          `OpenAI embeddings request timed out after ${this.timeoutMs}ms`,
          'TIMEOUT'
        );
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new EmbeddingProviderError(
        `OpenAI embeddings network error: ${this.sanitizeErrorMessage(rawMessage)}`,
        'NETWORK_ERROR'
      );
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        const json = (await response.json()) as { error?: { message?: string } };
        errorBody = json?.error?.message ?? '';
      } catch {
        try {
          errorBody = await response.text();
        } catch {
          errorBody = 'Unable to read response body';
        }
      }

      const safeMessage = this.sanitizeErrorMessage(errorBody);
      throw new EmbeddingProviderError(
        `OpenAI embeddings API error (${response.status}): ${safeMessage || response.statusText}`,
        'PROVIDER_ERROR',
        response.status
      );
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      throw new EmbeddingProviderError(
        'Failed to parse JSON response from OpenAI embeddings endpoint',
        'MALFORMED_RESPONSE'
      );
    }

    const typedData = responseJson as {
      data?: Array<{ index?: number; embedding?: unknown }>;
    };

    if (!typedData || !Array.isArray(typedData.data)) {
      throw new EmbeddingProviderError(
        'Invalid response structure from OpenAI: missing "data" array',
        'MALFORMED_RESPONSE'
      );
    }

    if (typedData.data.length !== batch.length) {
      throw new EmbeddingProviderError(
        `Expected ${batch.length} embeddings in response, received ${typedData.data.length}`,
        'MALFORMED_RESPONSE'
      );
    }

    // Sort by item index to preserve order
    const sorted = [...typedData.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: number[][] = [];

    for (let j = 0; j < sorted.length; j++) {
      const item = sorted[j];
      const embedding = item?.embedding;

      if (!Array.isArray(embedding)) {
        throw new EmbeddingProviderError(
          `Embedding at index ${offset + j} is not an array`,
          'MALFORMED_RESPONSE'
        );
      }

      if (embedding.length !== this.dimensions) {
        throw new EmbeddingProviderError(
          `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`,
          'INVALID_DIMENSION'
        );
      }

      for (let k = 0; k < embedding.length; k++) {
        const val = embedding[k];
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          throw new EmbeddingProviderError(
            `Embedding at index ${offset + j} contains non-finite number at dimension ${k}`,
            'MALFORMED_RESPONSE'
          );
        }
      }

      vectors.push(embedding as number[]);
    }

    return vectors;
  }

  /**
   * Redacts sensitive strings (API keys, Bearer tokens) from error messages.
   */
  private sanitizeErrorMessage(message: string): string {
    return message
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
      .slice(0, 500);
  }
}

/**
 * Creates an EmbeddingProvider instance based on application configuration.
 */
export function createEmbeddingProvider(env: ApiEnv): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER === 'openai') {
    if (!env.OPENAI_API_KEY) {
      if (env.NODE_ENV === 'test') {
        return new MockEmbeddingProvider({
          model: env.OPENAI_EMBEDDING_MODEL || 'mock-text-embedding-3-small',
          dimensions: env.EMBEDDING_DIMENSIONS || 1536,
        });
      }
      throw new EmbeddingProviderError(
        'OPENAI_API_KEY is required when EMBEDDING_PROVIDER is "openai"',
        'MISSING_API_KEY'
      );
    }
    return new OpenAIEmbeddingProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      batchSize: env.EMBEDDING_BATCH_SIZE,
      timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    });
  }

  // Default to mock provider
  return new MockEmbeddingProvider({
    model: env.OPENAI_EMBEDDING_MODEL || 'mock-text-embedding-3-small',
    dimensions: env.EMBEDDING_DIMENSIONS || 1536,
  });
}
