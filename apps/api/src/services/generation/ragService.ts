import { getEnv } from '../../config/env.js';
import type { EmbeddingProvider } from '../ingestion/types.js';
import { searchSimilarChunks } from '../retrieval/vectorSearch.js';
import { createLLMProvider } from './groqProvider.js';
import { buildRAGPrompt } from './promptBuilder.js';
import type { LLMProvider, RAGQueryParams, RAGQueryResult } from './types.js';

export interface RAGServiceOptions {
  embeddingProvider?: EmbeddingProvider | undefined;
  llmProvider?: LLMProvider | undefined;
}

/**
 * End-to-end grounded RAG answering service.
 *
 * Workflow:
 * 1. Semantic retrieval of top-K chunks scoped strictly to the authorized tenant.
 * 2. If no chunks found, returns safe insufficient-evidence result without invoking LLM.
 * 3. Builds a bounded prompt with anti-prompt-injection security instructions.
 * 4. Calls configured Groq LLM (or mock provider in test/offline mode).
 * 5. Returns grounded answer, candidate chunk provenance, and granular latency breakdowns.
 */
export async function queryRAG(
  params: RAGQueryParams,
  options: RAGServiceOptions = {}
): Promise<RAGQueryResult> {
  const env = getEnv();

  // 1. Vector Search across tenant-scoped document chunks
  const retrievalResult = await searchSimilarChunks(
    {
      organizationId: params.organizationId,
      query: params.query,
      topK: params.topK,
      documentId: params.documentId,
    },
    options.embeddingProvider
  );

  // 2. Early return if no candidate chunks are indexed or found
  if (retrievalResult.chunks.length === 0) {
    return {
      query: retrievalResult.query,
      answer: 'I cannot answer this question because no relevant documentation was found in this workspace.',
      chunks: [],
      contextChunksCount: 0,
      insufficientEvidence: true,
      model: 'none',
      provider: 'none',
      latency: {
        embeddingMs: retrievalResult.latency.embeddingMs,
        retrievalMs: retrievalResult.latency.retrievalMs,
        generationMs: 0,
        totalMs: retrievalResult.latency.totalMs,
      },
    };
  }

  // 3. Assemble bounded context
  const maxContextChars = params.maxContextChars ?? env.RAG_MAX_CONTEXT_CHARS ?? 12000;
  const { systemPrompt, userPrompt, includedChunks } = buildRAGPrompt(
    retrievalResult.query,
    retrievalResult.chunks,
    maxContextChars
  );

  // 4. Invoke LLM provider with timeout and error protection
  const llmProvider = options.llmProvider ?? createLLMProvider(env);
  const startGen = Date.now();
  const generationResult = await llmProvider.generate(userPrompt, systemPrompt);
  const generationDurationMs = Math.max(0, Date.now() - startGen);

  const answer = generationResult.content;
  const insufficientEvidence =
    answer.toLowerCase().includes('cannot answer this question based on the provided documentation') ||
    answer.toLowerCase().includes('insufficient evidence');

  const totalDurationMs = retrievalResult.latency.totalMs + generationDurationMs;

  return {
    query: retrievalResult.query,
    answer,
    chunks: includedChunks,
    contextChunksCount: includedChunks.length,
    insufficientEvidence,
    model: generationResult.model,
    provider: generationResult.provider,
    latency: {
      embeddingMs: retrievalResult.latency.embeddingMs,
      retrievalMs: retrievalResult.latency.retrievalMs,
      generationMs: generationDurationMs,
      totalMs: totalDurationMs,
    },
  };
}
