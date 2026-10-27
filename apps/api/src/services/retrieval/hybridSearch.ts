import type { EmbeddingProvider } from '../ingestion/types.js';
import { getEnv } from '../../config/env.js';
import { normalizeQueryText, searchSimilarChunks } from './vectorSearch.js';
import { searchLexicalChunks } from './lexicalSearch.js';
import { DEFAULT_RRF_K, fuseRankingsRRF } from './rrf.js';
import {
  type HybridSearchParams,
  type HybridSearchResult,
  RetrievalError,
} from './types.js';

/**
 * Unified search service supporting Vector, Keyword (Lexical), and Hybrid (RRF) retrieval.
 *
 * Retrieval Modes:
 * - 'vector': Pure semantic similarity using pgvector cosine distance.
 * - 'keyword': Pure lexical full-text search using PostgreSQL tsvector and ts_rank_cd.
 * - 'hybrid': Dual-retriever execution fused using Reciprocal Rank Fusion (RRF).
 */
export async function searchHybridChunks(
  params: HybridSearchParams,
  overrideEmbeddingProvider?: EmbeddingProvider
): Promise<HybridSearchResult> {
  const env = getEnv();
  const { organizationId, query: rawQuery } = params;

  if (!organizationId) {
    throw new RetrievalError('Organization ID is required for search', 'INVALID_PARAM', 400);
  }

  const normalizedQuery = normalizeQueryText(rawQuery ?? '');
  if (!normalizedQuery || normalizedQuery.length === 0) {
    throw new RetrievalError('Query string must not be empty', 'EMPTY_QUERY', 400);
  }

  if (normalizedQuery.length > 2000) {
    throw new RetrievalError('Query exceeds maximum allowed limit of 2000 characters', 'QUERY_TOO_LONG', 400);
  }

  const mode = params.mode ?? 'hybrid';
  if (!['hybrid', 'vector', 'keyword'].includes(mode)) {
    throw new RetrievalError(
      `Invalid retrieval mode: '${mode}'. Supported modes are 'hybrid', 'vector', 'keyword'.`,
      'INVALID_MODE',
      400
    );
  }

  // Bound topK and candidateCount
  const maxAllowedTopK = env.RAG_MAX_TOP_K || 20;
  const rawTopK = params.topK ?? 5;
  const topK = Math.min(Math.max(1, rawTopK), maxAllowedTopK);

  const rawCandidateCount = params.candidateCount ?? Math.max(topK * 2, 20);
  const candidateCount = Math.min(Math.max(topK, rawCandidateCount), 100);

  const rawRrfK = params.rrfK ?? DEFAULT_RRF_K;
  const rrfK = Math.min(Math.max(1, rawRrfK), 500);

  // 1. Vector-only mode
  if (mode === 'vector') {
    const vectorResult = await searchSimilarChunks(
      {
        organizationId,
        query: normalizedQuery,
        topK,
        documentId: params.documentId,
        versionId: params.versionId,
        similarityThreshold: params.similarityThreshold,
        metadataFilter: params.metadataFilter,
      },
      overrideEmbeddingProvider
    );

    return {
      query: vectorResult.query,
      mode: 'vector',
      chunks: vectorResult.chunks,
      totalCandidates: vectorResult.totalCandidates,
      embeddingModel: vectorResult.embeddingModel,
      latency: vectorResult.latency,
    };
  }

  // 2. Keyword-only mode
  if (mode === 'keyword') {
    const lexicalResult = await searchLexicalChunks({
      organizationId,
      query: normalizedQuery,
      topK,
      documentId: params.documentId,
      versionId: params.versionId,
      metadataFilter: params.metadataFilter,
    });

    return {
      query: lexicalResult.query,
      mode: 'keyword',
      chunks: lexicalResult.chunks,
      totalCandidates: lexicalResult.totalCandidates,
      latency: {
        embeddingMs: 0,
        retrievalMs: lexicalResult.latency.retrievalMs,
        totalMs: lexicalResult.latency.totalMs,
      },
    };
  }

  // 3. Hybrid mode: Run vector and lexical retrieval in parallel, then fuse with RRF
  const [vectorResult, lexicalResult] = await Promise.all([
    searchSimilarChunks(
      {
        organizationId,
        query: normalizedQuery,
        topK: candidateCount,
        documentId: params.documentId,
        versionId: params.versionId,
        similarityThreshold: params.similarityThreshold,
        metadataFilter: params.metadataFilter,
      },
      overrideEmbeddingProvider
    ),
    searchLexicalChunks({
      organizationId,
      query: normalizedQuery,
      topK: candidateCount,
      documentId: params.documentId,
      versionId: params.versionId,
      metadataFilter: params.metadataFilter,
    }),
  ]);

  const startFusion = Date.now();
  const fusedChunks = fuseRankingsRRF(
    vectorResult.chunks,
    lexicalResult.chunks,
    { k: rrfK, topK }
  );
  const fusionMs = Math.max(0, Date.now() - startFusion);

  const retrievalMs = Math.max(
    vectorResult.latency.retrievalMs,
    lexicalResult.latency.retrievalMs
  );
  const totalMs = vectorResult.latency.embeddingMs + retrievalMs + fusionMs;

  return {
    query: normalizedQuery,
    mode: 'hybrid',
    chunks: fusedChunks,
    totalCandidates: fusedChunks.length,
    embeddingModel: vectorResult.embeddingModel,
    rrfK,
    latency: {
      embeddingMs: vectorResult.latency.embeddingMs,
      retrievalMs,
      fusionMs,
      totalMs,
    },
  };
}
