import { query } from '@devdocs/db';
import type { RetrievedChunk } from '@devdocs/shared';
import { getEnv } from '../../config/env.js';
import { normalizeQueryText } from './vectorSearch.js';
import { type LexicalSearchParams, type LexicalSearchResult, RetrievalError } from './types.js';

interface RawLexicalRow {
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
  lexical_score: number;
}

/**
 * Searches for keyword-matching document chunks in an organization's workspace
 * using PostgreSQL full-text search (tsvector/GIN) with cover density ranking (ts_rank_cd).
 *
 * Especially suited for:
 * - Exact API route paths (e.g. "/api/documents/:id/ingest")
 * - Technical code identifiers (e.g. "getUserById", "maxContextChars")
 * - Error codes (e.g. "ERR_AUTH_FAILED", "DOCUMENT_NOT_FOUND")
 * - File paths and file names (e.g. "src/routes/auth.ts")
 * - Boolean queries (using standard websearch syntax: "OR", quotes, negation)
 *
 * Security & Isolation Guarantees:
 * - Scoped strictly to the caller's organization ID in SQL.
 * - Restricts candidates to ready current document versions only.
 * - Parameterized SQL queries preventing injection.
 */
export async function searchLexicalChunks(
  params: LexicalSearchParams
): Promise<LexicalSearchResult> {
  const env = getEnv();
  const { organizationId, query: rawQuery, documentId, versionId, metadataFilter } = params;

  if (!organizationId) {
    throw new RetrievalError('Organization ID is required for lexical search', 'INVALID_PARAM', 400);
  }

  const normalizedQuery = normalizeQueryText(rawQuery ?? '');
  if (!normalizedQuery || normalizedQuery.length === 0) {
    throw new RetrievalError('Query string must not be empty', 'EMPTY_QUERY', 400);
  }

  if (normalizedQuery.length > 2000) {
    throw new RetrievalError('Query exceeds maximum allowed limit of 2000 characters', 'QUERY_TOO_LONG', 400);
  }

  // Bound topK
  const maxAllowedTopK = env.RAG_MAX_TOP_K || 20;
  const rawTopK = params.topK ?? 5;
  const topK = Math.min(Math.max(1, rawTopK), maxAllowedTopK);

  const startRetrieval = Date.now();

  // Helper to execute FTS query against PostgreSQL
  const executeQuery = async (tsqueryString: string): Promise<RawLexicalRow[]> => {
    const sqlParams: unknown[] = [tsqueryString, organizationId];
    let paramIdx = 3;

    let docFilterClause = '';
    if (documentId) {
      docFilterClause = `AND d.id = $${paramIdx++}`;
      sqlParams.push(documentId);
    }

    let versionFilterClause = 'AND dv.id = d.current_version_id';
    if (versionId) {
      versionFilterClause = `AND dv.id = $${paramIdx++}`;
      sqlParams.push(versionId);
    }

    let metadataFilterClause = '';
    if (metadataFilter && Object.keys(metadataFilter).length > 0) {
      metadataFilterClause = `AND c.metadata @> $${paramIdx++}::jsonb`;
      sqlParams.push(JSON.stringify(metadataFilter));
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
        ts_rank_cd(c.search_vector, query_ts) AS lexical_score
      FROM chunks c
      JOIN document_versions dv ON c.document_version_id = dv.id
      JOIN documents d ON dv.document_id = d.id
      CROSS JOIN websearch_to_tsquery('english', $1) AS query_ts
      WHERE d.organization_id = $2
        AND dv.status = 'ready'
        ${versionFilterClause}
        AND query_ts != ''::tsquery
        AND c.search_vector @@ query_ts
        ${docFilterClause}
        ${metadataFilterClause}
      ORDER BY lexical_score DESC, c.chunk_index ASC, c.id ASC
      LIMIT $${limitParamIdx}
    `;

    const res = await query<RawLexicalRow>(sql, sqlParams);
    return res.rows;
  };

  let rows: RawLexicalRow[];
  try {
    // 1. Primary search: websearch_to_tsquery
    rows = await executeQuery(normalizedQuery);

    // 2. Fallback search: if strict multi-word search found 0 candidates and contains no quotes or explicit OR
    if (
      rows.length === 0 &&
      !normalizedQuery.includes('"') &&
      !normalizedQuery.toUpperCase().includes(' OR ')
    ) {
      const words = normalizedQuery.split(/\s+/).filter((w) => w.length > 1);
      if (words.length > 1) {
        const orQuery = words.join(' OR ');
        rows = await executeQuery(orQuery);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Database query failure';
    throw new RetrievalError(`Lexical search failed in database: ${message}`, 'DATABASE_ERROR', 500);
  }

  const retrievalDurationMs = Math.max(0, Date.now() - startRetrieval);

  // Format retrieved candidate chunks
  const chunks: RetrievedChunk[] = rows.map((row, index) => {
    const score = Number(Number(row.lexical_score).toFixed(6));
    const rank = index + 1;
    return {
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
      similarityScore: undefined,
      distance: undefined,
      rank,
      score,
      vectorRank: null,
      vectorScore: null,
      lexicalRank: rank,
      lexicalScore: score,
      rrfScore: null,
      metadata: row.metadata ?? {},
    };
  });

  return {
    query: normalizedQuery,
    chunks,
    totalCandidates: chunks.length,
    latency: {
      retrievalMs: retrievalDurationMs,
      totalMs: retrievalDurationMs,
    },
  };
}
