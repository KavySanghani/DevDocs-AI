import { query } from '@devdocs/db';
import type { DocumentSourceType, DocumentStatus, IngestionResult } from '@devdocs/shared';
import { getEnv } from '../../config/env.js';
import { normalizeDocumentText } from './normalizer.js';
import { chunkDocument } from './chunker.js';
import { createEmbeddingProvider } from './embeddingProvider.js';
import { persistChunksWithEmbeddings } from './chunkPersistence.js';
import {
  type ChunkWithEmbedding,
  type IngestDocumentParams,
  type IngestionStage,
  type EmbeddingProvider,
  IngestionError,
  EmbeddingProviderError,
} from './types.js';

interface DocumentVersionRow {
  document_id: string;
  organization_id: string;
  document_name: string;
  source_type: DocumentSourceType;
  version_id: string;
  version_number: number;
  version_status: DocumentStatus;
  content_hash: string;
  source_details: Record<string, unknown> | null;
}

/**
 * Sanitizes and redacts sensitive strings (API keys, Bearer tokens) from error messages.
 */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}

/**
 * Executes the 6-stage document chunking and embedding pipeline:
 * 1. Validation / extracted-text check
 * 2. Normalization / cleaning preserving structure
 * 3. Structure-aware chunking
 * 4. Embedding generation through provider interface
 * 5. Persistence of chunks, pgvector embeddings, and search metadata
 * 6. Finalizing document version status, metrics, and error state
 */
export async function ingestDocumentVersion(
  params: IngestDocumentParams
): Promise<IngestionResult> {
  const { documentId, documentVersionId, organizationId, config } = params;
  const startTime = Date.now();

  let currentStage: IngestionStage = 'validation';
  let targetVersionId = documentVersionId;
  let existingSourceDetails: Record<string, unknown> = {};

  try {
    // Stage 1: Validation / extracted text check
    currentStage = 'validation';

    const versionQuery = targetVersionId
      ? `SELECT
           d.id AS document_id,
           d.organization_id,
           d.name AS document_name,
           d.source_type,
           dv.id AS version_id,
           dv.version_number,
           dv.status AS version_status,
           dv.content_hash,
           dv.source_details
         FROM documents d
         JOIN document_versions dv ON dv.document_id = d.id
         WHERE d.id = $1 AND d.organization_id = $2 AND dv.id = $3
         LIMIT 1`
      : `SELECT
           d.id AS document_id,
           d.organization_id,
           d.name AS document_name,
           d.source_type,
           dv.id AS version_id,
           dv.version_number,
           dv.status AS version_status,
           dv.content_hash,
           dv.source_details
         FROM documents d
         JOIN document_versions dv ON dv.id = d.current_version_id
         WHERE d.id = $1 AND d.organization_id = $2
         LIMIT 1`;

    const queryParams = targetVersionId
      ? [documentId, organizationId, targetVersionId]
      : [documentId, organizationId];

    const versionRes = await query<DocumentVersionRow>(versionQuery, queryParams);

    if (versionRes.rows.length === 0) {
      throw new IngestionError(
        'Document or version not found for this organization',
        'validation',
        404
      );
    }

    const row = versionRes.rows[0]!;
    targetVersionId = row.version_id;
    existingSourceDetails = (row.source_details as Record<string, unknown>) ?? {};

    const rawText = existingSourceDetails.rawText;
    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
      throw new IngestionError(
        'Document version has no extracted raw text available for ingestion',
        'validation',
        400
      );
    }

    // Set status to processing during ingestion
    await query(
      `UPDATE document_versions
       SET status = 'processing',
           updated_at = now()
       WHERE id = $1`,
      [targetVersionId]
    );

    // Stage 2: Normalization / cleaning preserving structure
    currentStage = 'normalization';
    const normalizedText = normalizeDocumentText(rawText);

    if (normalizedText.trim().length === 0) {
      throw new IngestionError(
        'Document text is empty after normalization',
        'normalization',
        400
      );
    }

    // Stage 3: Structure-aware chunking
    currentStage = 'chunking';
    const chunks = chunkDocument({
      documentName: row.document_name,
      sourceType: row.source_type,
      rawText: normalizedText,
      sourceDetails: existingSourceDetails,
      config,
    });

    if (chunks.length === 0) {
      throw new IngestionError(
        'Chunking produced zero chunks from document text',
        'chunking',
        422
      );
    }

    // Stage 4: Embedding generation
    currentStage = 'embedding';
    const provider: EmbeddingProvider =
      params.provider ?? createEmbeddingProvider(getEnv());

    const textsToEmbed = chunks.map((c) => c.content);
    let rawEmbeddings: number[][];

    try {
      rawEmbeddings = await provider.embedChunks(textsToEmbed);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      throw new IngestionError(
        `Embedding generation failed: ${errMessage}`,
        'embedding',
        err instanceof EmbeddingProviderError ? err.statusCode : 502,
        err
      );
    }

    if (rawEmbeddings.length !== chunks.length) {
      throw new IngestionError(
        `Embedding count mismatch: expected ${chunks.length}, received ${rawEmbeddings.length}`,
        'embedding',
        502
      );
    }

    // Validate returned embeddings
    for (let i = 0; i < rawEmbeddings.length; i++) {
      const vec = rawEmbeddings[i]!;
      if (!Array.isArray(vec) || vec.length !== provider.dimensions) {
        throw new IngestionError(
          `Embedding at index ${i} has invalid dimension: expected ${provider.dimensions}, got ${vec?.length ?? 'none'}`,
          'embedding',
          502
        );
      }

      for (let d = 0; d < vec.length; d++) {
        if (!Number.isFinite(vec[d])) {
          throw new IngestionError(
            `Embedding at index ${i} contains non-finite number at dimension ${d}`,
            'embedding',
            502
          );
        }
      }
    }

    const chunksWithEmbeddings: ChunkWithEmbedding[] = chunks.map((chunk, idx) => ({
      ...chunk,
      embedding: rawEmbeddings[idx]!,
    }));

    // Stage 5: Persistence
    currentStage = 'persistence';
    await persistChunksWithEmbeddings({
      documentVersionId: targetVersionId,
      organizationId,
      documentId: row.document_id,
      chunks: chunksWithEmbeddings,
    });

    // Stage 6: Finalization & status update
    currentStage = 'finalization';
    const totalCharacters = chunks.reduce((acc, c) => acc + c.characterCount, 0);
    const totalEstimatedTokens = chunks.reduce((acc, c) => acc + c.tokenCount, 0);
    const ingestedAt = new Date().toISOString();

    const updatedSourceDetails = {
      ...existingSourceDetails,
      chunkCount: chunks.length,
      totalCharacters,
      totalEstimatedTokens,
      embeddingModel: provider.model,
      embeddingDimensions: provider.dimensions,
      ingestedAt,
      errorStage: null,
    };

    await query(
      `UPDATE document_versions
       SET status = 'ready',
           error_message = NULL,
           source_details = $1,
           updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(updatedSourceDetails), targetVersionId]
    );

    await query(
      `UPDATE documents SET updated_at = now() WHERE id = $1`,
      [row.document_id]
    );

    return {
      documentId: row.document_id,
      versionId: targetVersionId,
      chunkCount: chunks.length,
      totalCharacters,
      totalEstimatedTokens,
      embeddingModel: provider.model,
      status: 'ready',
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeMessage = sanitizeErrorMessage(rawMessage);
    const stage = err instanceof IngestionError ? err.stage : currentStage;

    // Fail the document version if targetVersionId is resolved
    if (targetVersionId) {
      const failedDetails = {
        ...existingSourceDetails,
        errorStage: stage,
        failedAt: new Date().toISOString(),
      };

      try {
        await query(
          `UPDATE document_versions
           SET status = 'failed',
               error_message = $1,
               source_details = $2,
               updated_at = now()
           WHERE id = $3`,
          [safeMessage, JSON.stringify(failedDetails), targetVersionId]
        );
      } catch {
        // Suppress secondary update failure to rethrow primary error
      }
    }

    if (err instanceof IngestionError) {
      throw err;
    }

    throw new IngestionError(
      `Ingestion failed during ${stage}: ${safeMessage}`,
      stage,
      500,
      err
    );
  }
}
