import { query } from '@devdocs/db';
import type { RetrievedChunk } from '@devdocs/shared';
import { getEnv } from '../../config/env.js';
import { createEmbeddingProvider } from '../ingestion/embeddingProvider.js';
import { type EmbeddingProvider, EmbeddingProviderError } from '../ingestion/types.js';
import { type VectorSearchParams, type VectorSearchResult, RetrievalError } from './types.js';

/**
 * Normalizes query text by removing control characters, collapsing redundant whitespace,
 * and trimming boundaries.
 */
export function normalizeQueryText(raw: string): string {
  return raw
    .replace(/\r\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RawChunkRow {
  id: string;
  document_version_id: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  character_count: number;
  token_count: number | null;
  page_number: number | null;
  section_title: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  metadata: Record<string, unknown> | null;
  distance: number;
  similarity: number;
}

/**
 * Searches for semantically similar document chunks in an organization's workspace using pgvector cosine distance.
 *
 * Security & Isolation Guarantees:
 * - Scoped strictly to the caller's organization ID in SQL.
 * - Restricts candidates to ready documents and ready current versions only (never stale or failed versions).
 * - Enforces parameterized SQL queries and bounds topK.
 */
export async function searchSimilarChunks(
  params: VectorSearchParams,
  overrideProvider?: EmbeddingProvider
): Promise<VectorSearchResult> {
  const env = getEnv();
  const { organizationId, query: rawQuery, documentId, similarityThreshold } = params;

  if (!organizationId) {
    throw new RetrievalError('Organization ID is required for vector search', 'INVALID_PARAM', 400);
  }

  const normalizedQuery = normalizeQueryText(rawQuery ?? '');
  if (!normalizedQuery || normalizedQuery.length === 0) {
    throw new RetrievalError('Query string must not be empty', 'EMPTY_QUERY', 400);
  }

  if (normalizedQuery.length > 2000) {
    throw new RetrievalError('Query exceeds maximum allowed limit of 2000 characters', 'QUERY_TOO_LONG', 400);
  }

  // Bound topK between 1 and configured RAG_MAX_TOP_K (default 5, max 50)
  const maxAllowedTopK = env.RAG_MAX_TOP_K || 20;
  const rawTopK = params.topK ?? 5;
  const topK = Math.min(Math.max(1, rawTopK), maxAllowedTopK);

  // 1. Generate query embedding using matching provider & configuration
  const provider = overrideProvider ?? createEmbeddingProvider(env);
  const startEmbedding = Date.now();

  let queryVector: number[];
  try {
    const vectors = await provider.embedChunks([normalizedQuery]);
    const firstVec = vectors[0];
    if (!firstVec || firstVec.length === 0) {
      throw new RetrievalError('Embedding provider returned empty vector for query', 'EMBEDDING_FAILED', 502);
    }
    queryVector = firstVec;
  } catch (err) {
    if (err instanceof RetrievalError) {
      throw err;
    }
    if (err instanceof EmbeddingProviderError) {
      throw new RetrievalError(
        `Failed to generate query embedding: ${err.message}`,
        err.code,
        err.statusCode
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown embedding failure';
    throw new RetrievalError(`Failed to generate query embedding: ${message}`, 'EMBEDDING_FAILED', 502);
  }

  const embeddingDurationMs = Math.max(0, Date.now() - startEmbedding);

  // 2. Execute pgvector cosine similarity search in PostgreSQL
  const startRetrieval = Date.now();
  const vectorString = `[${queryVector.join(',')}]`;

  const sqlParams: unknown[] = [vectorString, organizationId];
  let paramIdx = 3;

  let docFilterClause = '';
  if (documentId) {
    docFilterClause = `AND d.id = $${paramIdx++}`;
    sqlParams.push(documentId);
  }

  let thresholdClause = '';
  if (typeof similarityThreshold === 'number') {
    thresholdClause = `AND (1 - (c.embedding <=> $1::vector)) >= $${paramIdx++}`;
    sqlParams.push(similarityThreshold);
  }

  const limitParamIdx = paramIdx;
  sqlParams.push(topK);

  const sql = `
    SELECT
      c.id,
      c.document_version_id,
      dv.document_id,
      d.name AS document_name,
      c.chunk_index,
      c.content,
      c.character_count,
      c.token_count,
      c.page_number,
      c.section_title,
      c.file_path,
      c.line_start,
      c.line_end,
      c.metadata,
      (c.embedding <=> $1::vector) AS distance,
      (1 - (c.embedding <=> $1::vector)) AS similarity
    FROM chunks c
    JOIN document_versions dv ON c.document_version_id = dv.id
    JOIN documents d ON dv.document_id = d.id
    WHERE d.organization_id = $2
      AND dv.status = 'ready'
      AND dv.id = d.current_version_id
      AND c.embedding IS NOT NULL
      ${docFilterClause}
      ${thresholdClause}
    ORDER BY distance ASC
    LIMIT $${limitParamIdx}
  `;

  let rows: RawChunkRow[];
  try {
    const result = await query<RawChunkRow>(sql, sqlParams);
    rows = result.rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Database query failure';
    throw new RetrievalError(`Vector search failed in database: ${message}`, 'DATABASE_ERROR', 500);
  }

  const retrievalDurationMs = Math.max(0, Date.now() - startRetrieval);

  // 3. Format retrieved candidate chunks
  const chunks: RetrievedChunk[] = rows.map((row, index) => ({
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    documentVersionId: row.document_version_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    characterCount: row.character_count,
    tokenCount: row.token_count,
    pageNumber: row.page_number,
    sectionTitle: row.section_title,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    similarityScore: Number(Number(row.similarity).toFixed(6)),
    distance: Number(Number(row.distance).toFixed(6)),
    rank: index + 1,
    metadata: row.metadata ?? {},
  }));

  return {
    query: normalizedQuery,
    chunks,
    totalCandidates: chunks.length,
    embeddingModel: provider.model,
    latency: {
      embeddingMs: embeddingDurationMs,
      retrievalMs: retrievalDurationMs,
      totalMs: embeddingDurationMs + retrievalDurationMs,
    },
  };
}
