import { withTransaction, query } from '@devdocs/db';
import { type ChunkWithEmbedding, type JobFencingContext, LeaseFencingError, IngestionError } from './types.js';

export interface PersistChunksParams {
  documentVersionId: string;
  organizationId: string;
  documentId: string;
  chunks: ChunkWithEmbedding[];
  fencingContext?: JobFencingContext | undefined;
  versionFinalization?: {
    sourceDetails: Record<string, unknown>;
  } | undefined;
  jobFinalization?: {
    payloadUpdates?: Record<string, unknown> | undefined;
  } | undefined;
}

export interface PersistChunksResult {
  insertedCount: number;
}

/**
 * Atomically validates worker lease ownership, replaces existing chunks with new pgvector embeddings,
 * and finalizes version and job status in a single PostgreSQL transaction.
 * Guaranteed split-brain safe: if lease or fencing token is invalid, rolls back before any chunk or version mutation.
 */
export async function persistChunksWithEmbeddings(
  params: PersistChunksParams
): Promise<PersistChunksResult> {
  const {
    documentVersionId,
    organizationId,
    documentId,
    chunks,
    fencingContext,
    versionFinalization,
    jobFinalization,
  } = params;

  return withTransaction(async (client) => {
    // 1. Authoritative Fencing & Lease Lock Check:
    // If a background worker is persisting, atomically validate ownership on the jobs table
    // with an exclusive row lock before deleting or inserting any chunks.
    if (fencingContext) {
      const { jobId, workerId, fencingToken } = fencingContext;
      const jobRes = await client.query<{
        id: string;
        status: string;
        locked_by: string | null;
        locked_until: Date | null;
        fencing_token: number;
        payload: Record<string, unknown>;
        is_lease_valid: boolean;
      }>(
        `SELECT id, status, locked_by, locked_until, fencing_token, payload,
                (locked_until > now()) AS is_lease_valid
         FROM jobs
         WHERE id = $1
         FOR UPDATE`,
        [jobId]
      );

      const jobRow = jobRes.rows[0];
      if (!jobRow) {
        throw new LeaseFencingError(`Job ${jobId} not found during chunk persistence.`);
      }

      if (jobRow.status !== 'processing') {
        throw new LeaseFencingError(
          `Job ${jobId} is in status '${jobRow.status}' (expected 'processing'); aborting chunk persistence.`
        );
      }

      if (jobRow.locked_by !== workerId) {
        throw new LeaseFencingError(
          `Job ${jobId} is locked by '${jobRow.locked_by}' (expected '${workerId}'); aborting chunk persistence.`
        );
      }

      if (jobRow.fencing_token !== fencingToken) {
        throw new LeaseFencingError(
          `Job ${jobId} fencing token is ${jobRow.fencing_token} (expected ${fencingToken}); aborting chunk persistence.`
        );
      }

      if (!jobRow.locked_until || !jobRow.is_lease_valid || jobRow.locked_until.getTime() <= Date.now()) {
        throw new LeaseFencingError(
          `Job ${jobId} lease expired at ${jobRow.locked_until?.toISOString() ?? 'null'}; aborting chunk persistence.`
        );
      }
    }

    // 2. Verify tenant isolation inside the transaction
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

    // 3. Clear any pre-existing chunks for this version (enables idempotent re-ingestion)
    await client.query(
      `DELETE FROM chunks WHERE document_version_id = $1`,
      [documentVersionId]
    );

    if (chunks.length > 0) {
      // 4. Insert chunks in batches (e.g. up to 50 chunks per multi-row INSERT)
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
    }

    // 5. Version Finalization: Mark document version ready inside the transaction
    if (versionFinalization) {
      await client.query(
        `UPDATE document_versions
         SET status = 'ready',
             error_message = NULL,
             source_details = $1,
             updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(versionFinalization.sourceDetails), documentVersionId]
      );

      await client.query(
        `UPDATE documents SET updated_at = now() WHERE id = $1`,
        [documentId]
      );
    }

    // 6. Job Finalization & Monotonic Pointer Activation:
    // If running in background worker mode (fencingContext present), finalize job and activate pointer atomically
    if (fencingContext) {
      const { jobId } = fencingContext;

      // Fetch current payload to merge updates
      const jobRowRes = await client.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM jobs WHERE id = $1',
        [jobId]
      );
      const currentPayload = jobRowRes.rows[0]?.payload ?? {};
      const mergedPayload = {
        ...currentPayload,
        ...(jobFinalization?.payloadUpdates ?? {}),
        stage: 'completed',
      };

      await client.query(
        `UPDATE jobs
         SET status = 'ready',
             locked_by = NULL,
             locked_until = NULL,
             error_summary = NULL,
             payload = $1,
             updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(mergedPayload), jobId]
      );

      // Monotonic pointer activation (F-04 Phase 9)
      await client.query(
        `UPDATE documents d
         SET current_version_id = new_v.id,
             updated_at = now()
         FROM document_versions new_v
         WHERE d.id = $2
           AND new_v.id = $1
           AND new_v.document_id = d.id
           AND new_v.status = 'ready'
           AND (
             d.current_version_id IS NULL
             OR new_v.version_number >= (
               SELECT cur_v.version_number
               FROM document_versions cur_v
               WHERE cur_v.id = d.current_version_id
             )
           )`,
        [documentVersionId, documentId]
      );
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
