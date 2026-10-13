import { withTransaction, query } from '@devdocs/db';
import { type ChunkWithEmbedding, IngestionError } from './types.js';

export interface PersistChunksParams {
  documentVersionId: string;
  organizationId: string;
  documentId: string;
  chunks: ChunkWithEmbedding[];
}

export interface PersistChunksResult {
  insertedCount: number;
}

/**
 * Atomically replaces any existing chunks for a document version with new chunks and pgvector embeddings.
 * Operates in a transaction to guarantee that partial ingestion is never visible.
 */
export async function persistChunksWithEmbeddings(
  params: PersistChunksParams
): Promise<PersistChunksResult> {
  const { documentVersionId, organizationId, documentId, chunks } = params;

  return withTransaction(async (client) => {
    // 1. Verify tenant isolation inside the transaction
    const docCheck = await client.query<{ id: string }>(
      `SELECT d.id
       FROM documents d
       JOIN document_versions dv ON dv.document_id = d.id
       WHERE dv.id = $1 AND d.id = $2 AND d.organization_id = $3
       LIMIT 1`,
      [documentVersionId, documentId, organizationId]
    );

    if (docCheck.rows.length === 0) {
      throw new IngestionError(
        `Document version ${documentVersionId} does not belong to organization ${organizationId}`,
        'persistence',
        404
      );
    }

    // 2. Clear any pre-existing chunks for this version (enables idempotent re-ingestion)
    await client.query(
      `DELETE FROM chunks WHERE document_version_id = $1`,
      [documentVersionId]
    );

    if (chunks.length === 0) {
      return { insertedCount: 0 };
    }

    // 3. Insert chunks in batches (e.g. up to 50 chunks per multi-row INSERT)
    const BATCH_SIZE = 50;

    for (let b = 0; b < chunks.length; b += BATCH_SIZE) {
      const slice = chunks.slice(b, b + BATCH_SIZE);
      const valueClauses: string[] = [];
      const values: unknown[] = [];
      let paramIdx = 1;

      for (const chunk of slice) {
        // Format embedding as pgvector string representation: '[0.1,0.2,...]'
        const vectorString = `[${chunk.embedding.join(',')}]`;

        const clause = `(
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++}::vector,
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++},
          $${paramIdx++}
        )`;

        valueClauses.push(clause);

        values.push(
          documentVersionId,
          chunk.chunkIndex,
          chunk.content,
          vectorString,
          chunk.tokenCount,
          chunk.characterCount,
          chunk.pageNumber ?? null,
          chunk.sectionTitle ? chunk.sectionTitle.slice(0, 255) : null,
          chunk.filePath ?? null,
          chunk.lineStart ?? null,
          chunk.lineEnd ?? null,
          JSON.stringify(chunk.metadata ?? {})
        );
      }

      const sql = `
        INSERT INTO chunks (
          document_version_id,
          chunk_index,
          content,
          embedding,
          token_count,
          character_count,
          page_number,
          section_title,
          file_path,
          line_start,
          line_end,
          metadata
        )
        VALUES ${valueClauses.join(',\n')}
      `;

      await client.query(sql, values);
    }

    return { insertedCount: chunks.length };
  });
}

export interface GetChunksQueryParams {
  documentVersionId: string;
  organizationId: string;
  page?: number;
  limit?: number;
}

export interface ChunkRecord {
  id: string;
  document_version_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  character_count: number | null;
  page_number: number | null;
  section_title: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Query persisted chunks with tenant isolation and pagination.
 */
export async function getPersistedChunks(params: GetChunksQueryParams): Promise<{
  chunks: ChunkRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const { documentVersionId, organizationId, page = 1, limit = 20 } = params;
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset = (safePage - 1) * safeLimit;

  // Tenant check on document_versions
  const countRes = await query<{ count: string }>(
    `SELECT COUNT(c.id) AS count
     FROM chunks c
     JOIN document_versions dv ON dv.id = c.document_version_id
     JOIN documents d ON d.id = dv.document_id
     WHERE c.document_version_id = $1 AND d.organization_id = $2`,
    [documentVersionId, organizationId]
  );

  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);
  const totalPages = Math.ceil(total / safeLimit) || 1;

  const dataRes = await query<ChunkRecord>(
    `SELECT
       c.id,
       c.document_version_id,
       c.chunk_index,
       c.content,
       c.token_count,
       c.character_count,
       c.page_number,
       c.section_title,
       c.file_path,
       c.line_start,
       c.line_end,
       c.metadata,
       c.created_at
     FROM chunks c
     JOIN document_versions dv ON dv.id = c.document_version_id
     JOIN documents d ON d.id = dv.document_id
     WHERE c.document_version_id = $1 AND d.organization_id = $2
     ORDER BY c.chunk_index ASC
     LIMIT $3 OFFSET $4`,
    [documentVersionId, organizationId, safeLimit, offset]
  );

  return {
    chunks: dataRes.rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages,
  };
}
