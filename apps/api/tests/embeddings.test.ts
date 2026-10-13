import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MockEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
} from '../src/services/ingestion/embeddingProvider.js';
import { EmbeddingProviderError } from '../src/services/ingestion/types.js';

describe('Phase 5: Embedding Providers & Adapter Boundary Unit Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. MockEmbeddingProvider', () => {
    it('produces deterministic 1536-dimensional L2-normalized unit vectors', async () => {
      const provider = new MockEmbeddingProvider();
      expect(provider.dimensions).toBe(1536);
      expect(provider.model).toBe('mock-text-embedding-3-small');

      const text = 'DevDocs AI Architecture - Postgres pgvector embeddings.';
      const [vector] = await provider.embedChunks([text]);

      expect(vector).toBeDefined();
      expect(vector!.length).toBe(1536);

      // Verify L2 unit-norm (sum of squares is ~1.0)
      const sumSq = vector!.reduce((acc, val) => acc + val * val, 0);
      expect(Math.abs(sumSq - 1.0)).toBeLessThan(0.01);
    });

    it('returns identical vectors for identical inputs and distinct vectors for distinct inputs', async () => {
      const provider = new MockEmbeddingProvider();
      const textA = 'Vector database retrieval with pgvector';
      const textB = 'Role-based access control and tenant isolation';

      const [vecA1, vecB1] = await provider.embedChunks([textA, textB]);
      const [vecA2] = await provider.embedChunks([textA]);

      expect(vecA1).toEqual(vecA2);
      expect(vecA1).not.toEqual(vecB1);
    });

    it('returns empty array when provided empty inputs', async () => {
      const provider = new MockEmbeddingProvider();
      const result = await provider.embedChunks([]);
      expect(result).toEqual([]);
    });

    it('simulates provider errors when simulatedError is configured', async () => {
      const provider = new MockEmbeddingProvider({
        simulatedError: 'Rate limit exceeded: 429',
      });

      await expect(provider.embedChunks(['test text'])).rejects.toThrow(
        EmbeddingProviderError
      );
    });

    it('simulates dimension variation when simulatedDimension is configured', async () => {
      const provider = new MockEmbeddingProvider({
        simulatedDimension: 512,
      });

      const [vector] = await provider.embedChunks(['test text']);
      expect(vector!.length).toBe(512);
    });
  });

  describe('2. OpenAIEmbeddingProvider', () => {
    const dummyApiKey = 'sk-proj-test1234567890abcdefghijklmnopqrstuvwxyz';

    it('requires non-empty API key on construction', () => {
      expect(() => new OpenAIEmbeddingProvider({ apiKey: '' })).toThrow(
        EmbeddingProviderError
      );
      expect(() => new OpenAIEmbeddingProvider({ apiKey: '   ' })).toThrow(
        EmbeddingProviderError
      );
    });

    it('successfully calls OpenAI endpoint with Bearer auth, batches, and parses vectors', async () => {
      const mockVector = new Array(1536).fill(0.025);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: mockVector },
              { index: 1, embedding: mockVector },
            ],
            model: 'text-embedding-3-small',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const provider = new OpenAIEmbeddingProvider({
        apiKey: dummyApiKey,
        model: 'text-embedding-3-small',
        dimensions: 1536,
      });

      const vectors = await provider.embedChunks(['Chunk 1', 'Chunk 2']);

      expect(vectors.length).toBe(2);
      expect(vectors[0]!.length).toBe(1536);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, requestInit] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://api.openai.com/v1/embeddings');
      expect((requestInit?.headers as Record<string, string>)?.Authorization).toBe(
        `Bearer ${dummyApiKey}`
      );
    });

    it('batches inputs according to configured batchSize', async () => {
      const mockVector = new Array(1536).fill(0.01);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        const inputs = body.input as string[];
        return new Response(
          JSON.stringify({
            data: inputs.map((_, idx) => ({ index: idx, embedding: mockVector })),
          }),
          { status: 200 }
        );
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: dummyApiKey,
        batchSize: 2,
      });

      const vectors = await provider.embedChunks(['C1', 'C2', 'C3', 'C4', 'C5']);

      expect(vectors.length).toBe(5);
      expect(fetchSpy).toHaveBeenCalledTimes(3); // 2 + 2 + 1
    });

    it('rejects vectors with invalid dimension', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], // 3 dims instead of 1536
          }),
          { status: 200 }
        )
      );

      const provider = new OpenAIEmbeddingProvider({
        apiKey: dummyApiKey,
        dimensions: 1536,
      });

      await expect(provider.embedChunks(['test'])).rejects.toThrow(
        /Embedding dimension mismatch/
      );
    });

    it('rejects vectors with non-finite numeric values', async () => {
      const invalidVector = new Array(1536).fill(0.1);
      invalidVector[10] = null; // null is not finite number

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: invalidVector }],
          }),
          { status: 200 }
        )
      );

      const provider = new OpenAIEmbeddingProvider({
        apiKey: dummyApiKey,
        dimensions: 1536,
      });

      await expect(provider.embedChunks(['test'])).rejects.toThrow(
        /contains non-finite number/
      );
    });

    it('sanitizes and redacts API key and sensitive tokens from error messages', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: `Invalid token for ${dummyApiKey}: key expired`,
            },
          }),
          { status: 401, statusText: 'Unauthorized' }
        )
      );

      const provider = new OpenAIEmbeddingProvider({
        apiKey: dummyApiKey,
      });

      try {
        await provider.embedChunks(['chunk']);
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(EmbeddingProviderError);
        const error = err as EmbeddingProviderError;
        expect(error.message).not.toContain(dummyApiKey);
        expect(error.message).toContain('[REDACTED_API_KEY]');
      }
    });

    it('handles request timeout gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const timeoutError = new Error('The operation was aborted due to timeout');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: dummyApiKey,
        timeoutMs: 100,
      });

      await expect(provider.embedChunks(['text'])).rejects.toThrow(
        /timed out after 100ms/
      );
    });
  });

  describe('3. Factory createEmbeddingProvider', () => {
    it('creates mock provider in test mode or when EMBEDDING_PROVIDER is mock', () => {
      const provider = createEmbeddingProvider({
        EMBEDDING_PROVIDER: 'mock',
        OPENAI_EMBEDDING_MODEL: 'mock-test',
        EMBEDDING_DIMENSIONS: 1536,
        NODE_ENV: 'test',
      } as any);

      expect(provider).toBeInstanceOf(MockEmbeddingProvider);
      expect(provider.dimensions).toBe(1536);
    });
  });

  describe('4. Opt-in Live OpenAI Smoke Test', () => {
    it.skipIf(!process.env.OPENAI_API_KEY)(
      'calls live OpenAI API when OPENAI_API_KEY is explicitly supplied in environment',
      async () => {
        const apiKey = process.env.OPENAI_API_KEY!;
        const provider = new OpenAIEmbeddingProvider({
          apiKey,
          model: 'text-embedding-3-small',
          dimensions: 1536,
        });

        const [vector] = await provider.embedChunks(['DevDocs AI pgvector live smoke test']);
        expect(vector).toBeDefined();
        expect(vector!.length).toBe(1536);
        expect(Number.isFinite(vector![0])).toBe(true);
      }
    );
  });
});
