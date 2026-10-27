import { query, withTransaction } from '@devdocs/db';
import {
  type DocumentDetailResponse,
  type DocumentResponse,
  type DocumentSourceType,
  type DocumentStatus,
  type DocumentVersionSummary,
  type DocumentVersionListResponse,
  type ActivateVersionResponse,
  type DocumentReindexResponse,
  hasMinimumRole,
} from '@devdocs/shared';
import { parseDocument, ParseError } from './parsers/index.js';
import { validateDocumentFile } from './documentValidation.js';
import { getOrganizationMember } from './organizationService.js';
import { ingestDocumentVersion } from './ingestion/index.js';
import { IngestionError, type EmbeddingProvider } from './ingestion/types.js';

export class DocError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = 'BAD_REQUEST',
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DocError';
  }
}

export interface UploadDocumentParams {
  organizationId: string;
  userId: string;
  filename: string;
  buffer: Buffer;
  declaredMimeType?: string | undefined;
  customName?: string | undefined;
  maxSizeBytes?: number | undefined;
  documentId?: string | undefined;
  provider?: EmbeddingProvider | undefined;
}

export interface ListDocumentsParams {
  organizationId: string;
  page?: number | undefined;
  limit?: number | undefined;
  sourceType?: DocumentSourceType | undefined;
  status?: DocumentStatus | undefined;
}

export interface ListDocumentsResult {
  documents: DocumentResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface DocumentRow {
  id: string;
  organization_id: string;
  created_by: string | null;
  name: string;
  source_type: DocumentSourceType;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
  version_number?: number;
  content_hash?: string;
  status?: DocumentStatus;
  error_message?: string | null;
  source_details?: Record<string, unknown>;
}

/**
 * Handles uploading, validating, hashing, deduplicating,
 * and parsing an engineering document or creating a new version of an existing document.
 */
export async function uploadAndProcessDocument(
  params: UploadDocumentParams
): Promise<DocumentDetailResponse> {
  const {
    organizationId,
    userId,
    filename,
    buffer,
    declaredMimeType,
    customName,
    maxSizeBytes,
    documentId,
  } = params;

  // 1. Validate file format, extension, size, and magic bytes
  const validated = validateDocumentFile(
    filename,
    buffer,
    declaredMimeType,
    maxSizeBytes
  );

  const documentName = customName?.trim() || validated.filename;

  let targetDoc: {
    id: string;
    organization_id: string;
    name: string;
    source_type: DocumentSourceType;
    current_version_id: string | null;
    created_at: Date;
    created_by: string | null;
  };
  let createdVersion: {
    id: string;
    document_id: string;
    version_number: number;
    content_hash: string;
    status: DocumentStatus;
    created_at: Date;
    updated_at: Date;
  };

  if (documentId) {
    // Branch A: Adding a new version to an existing document.
    // Acquire a row-level lock on the parent document (FOR UPDATE) inside an atomic transaction.
    // This serializes concurrent version uploads for the same document, preventing duplicate
    // version-number collisions and guaranteeing distinct, monotonic version sequences.
    const { doc, version } = await withTransaction(async (client) => {
      const existingDocRes = await client.query<{
        id: string;
        organization_id: string;
        name: string;
        source_type: DocumentSourceType;
        current_version_id: string | null;
        created_at: Date;
        created_by: string | null;
      }>(
        `SELECT id, organization_id, name, source_type, current_version_id, created_at, created_by
         FROM documents
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [documentId, organizationId]
      );

      if (existingDocRes.rows.length === 0) {
        throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
      }

      const lockedDoc = existingDocRes.rows[0]!;

      // Deduplication Policy for existing document: check under row lock if content already exists
      const dupVersionRes = await client.query<{
        id: string;
        version_number: number;
        status: DocumentStatus;
      }>(
        `SELECT id, version_number, status
         FROM document_versions
         WHERE document_id = $1 AND content_hash = $2
         LIMIT 1`,
        [lockedDoc.id, validated.contentHash]
      );

      if (dupVersionRes.rows.length > 0) {
        const dup = dupVersionRes.rows[0]!;
        throw new DocError(
          `An identical version with this content already exists for document "${lockedDoc.name}" (version ${dup.version_number}).`,
          409,
          'DUPLICATE_VERSION',
          {
            existingDocumentId: lockedDoc.id,
            existingDocumentName: lockedDoc.name,
            existingVersionId: dup.id,
            versionNumber: dup.version_number,
            status: dup.status,
          }
        );
      }

      // Determine next version number atomically under the row lock
      const maxVerRes = await client.query<{ next_version: string }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
         FROM document_versions
         WHERE document_id = $1`,
        [lockedDoc.id]
      );
      const nextVer = parseInt(maxVerRes.rows[0]?.next_version ?? '2', 10);

      // Insert new version row atomically in 'processing' state
      const versionRes = await client.query<{
        id: string;
        document_id: string;
        version_number: number;
        content_hash: string;
        status: DocumentStatus;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, $2, $3, 'processing', $4)
         RETURNING id, document_id, version_number, content_hash, status, created_at, updated_at`,
        [
          lockedDoc.id,
          nextVer,
          validated.contentHash,
          JSON.stringify({
            originalFilename: validated.filename,
            mimeType: validated.mimeType,
            fileSizeBytes: validated.sizeBytes,
          }),
        ]
      );

      return { doc: lockedDoc, version: versionRes.rows[0]! };
    });

    targetDoc = doc;
    createdVersion = version;
  } else {
    // Branch B: Creating a brand new document - check organization-wide deduplication
    const duplicateCheck = await query<{
      document_id: string;
      document_name: string;
      version_id: string;
      status: DocumentStatus;
    }>(
      `SELECT d.id AS document_id, d.name AS document_name, dv.id AS version_id, dv.status
       FROM document_versions dv
       JOIN documents d ON d.id = dv.document_id
       WHERE d.organization_id = $1 AND dv.content_hash = $2
       LIMIT 1`,
      [organizationId, validated.contentHash]
    );

    if (duplicateCheck.rows.length > 0) {
      const existing = duplicateCheck.rows[0]!;
      throw new DocError(
        `An identical document with this content already exists in this organization ("${existing.document_name}").`,
        409,
        'DUPLICATE_DOCUMENT',
        {
          existingDocumentId: existing.document_id,
          existingDocumentName: existing.document_name,
          existingVersionId: existing.version_id,
          status: existing.status,
        }
      );
    }

    // Persist brand-new document and initial version 1 atomically in "processing" state
    const { doc, version } = await withTransaction(async (client) => {
      const docRes = await client.query<DocumentRow>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, organization_id, created_by, name, source_type, created_at, updated_at`,
        [organizationId, userId, documentName, validated.sourceType]
      );
      const createdDoc = docRes.rows[0]!;

      const versionRes = await client.query<{
        id: string;
        document_id: string;
        version_number: number;
        content_hash: string;
        status: DocumentStatus;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, $2, 'processing', $3)
         RETURNING id, document_id, version_number, content_hash, status, created_at, updated_at`,
        [
          createdDoc.id,
          validated.contentHash,
          JSON.stringify({
            originalFilename: validated.filename,
            mimeType: validated.mimeType,
            fileSizeBytes: validated.sizeBytes,
          }),
        ]
      );
      const ver = versionRes.rows[0]!;

      await client.query(
        'UPDATE documents SET current_version_id = $1, updated_at = now() WHERE id = $2',
        [ver.id, createdDoc.id]
      );

      return { doc: createdDoc, version: ver };
    });

    targetDoc = doc;
    createdVersion = version;
  }

  // 4. Parse document according to its source type
  let finalStatus: DocumentStatus = 'ready';
  let errorMessage: string | null = null;
  let sourceDetailsPayload: Record<string, unknown> = {
    originalFilename: validated.filename,
    mimeType: validated.mimeType,
    fileSizeBytes: validated.sizeBytes,
  };

  try {
    const parseResult = await parseDocument(validated.buffer, validated.sourceType);

    sourceDetailsPayload = {
      ...sourceDetailsPayload,
      rawText: parseResult.rawText,
      characterCount: parseResult.characterCount,
      wordCount: parseResult.wordCount,
      pageCount: parseResult.pageCount ?? null,
      pages: parseResult.pages ?? [],
      sections: parseResult.sections ?? [],
      metadata: parseResult.metadata ?? {},
    };
    finalStatus = 'processing';
  } catch (err) {
    finalStatus = 'failed';
    if (err instanceof ParseError) {
      errorMessage = err.message;
    } else if (err instanceof Error) {
      errorMessage = `Extraction error: ${err.message}`;
    } else {
      errorMessage = 'Document extraction failed due to an unexpected parsing error.';
    }
  }

  // 5. Update version status and extracted metadata
  await query(
    `UPDATE document_versions
     SET status = $1,
         error_message = $2,
         source_details = $3,
         updated_at = now()
     WHERE id = $4`,
    [finalStatus, errorMessage, JSON.stringify(sourceDetailsPayload), createdVersion.id]
  );

  // 6. If parsing succeeded, run the ingestion pipeline (chunking + embeddings + vector storage)
  if (finalStatus === 'processing') {
    try {
      const ingestRes = await ingestDocumentVersion({
        documentId: targetDoc!.id,
        documentVersionId: createdVersion.id,
        organizationId: targetDoc!.organization_id,
        ...(params.provider ? { provider: params.provider } : {}),
      });

      finalStatus = 'ready';
      errorMessage = null;
      sourceDetailsPayload = {
        ...sourceDetailsPayload,
        chunkCount: ingestRes.chunkCount,
        totalCharacters: ingestRes.totalCharacters,
        totalEstimatedTokens: ingestRes.totalEstimatedTokens,
        embeddingModel: ingestRes.embeddingModel,
      };

      // Set as active version on success only if:
      // 1. Candidate belongs to this document and is 'ready'
      // 2. Document currently has no active version OR candidate version_number >= current active version's number
      // This prevents a slower, older version from overwriting a newer current version (F-04).
      await query(
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
        [createdVersion.id, targetDoc!.id]
      );
    } catch (ingestErr) {
      finalStatus = 'failed';
      errorMessage =
        ingestErr instanceof Error ? ingestErr.message : 'Document ingestion pipeline failed';

      // Update version record with failed status and error message
      await query(
        `UPDATE document_versions
         SET status = 'failed',
             error_message = $1,
             updated_at = now()
         WHERE id = $2`,
        [errorMessage, createdVersion.id]
      );
      // NOTE: We deliberately do NOT update documents.current_version_id on failure!
    }
  }

  // 7. Fetch all versions for complete detail response
  const versionsRes = await query<{
    id: string;
    version_number: number;
    content_hash: string;
    status: DocumentStatus;
    error_message: string | null;
    source_details: Record<string, unknown> | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, version_number, content_hash, status, error_message, source_details, created_at, updated_at
     FROM document_versions
     WHERE document_id = $1
     ORDER BY version_number DESC`,
    [targetDoc!.id]
  );

  // Fetch actual current_version_id from documents table to reflect atomic activation outcome
  const docCurrentRes = await query<{ current_version_id: string | null }>(
    'SELECT current_version_id FROM documents WHERE id = $1',
    [targetDoc!.id]
  );
  const activeVersionId = docCurrentRes.rows[0]?.current_version_id ?? createdVersion.id;

  const versionSummaries: DocumentVersionSummary[] = versionsRes.rows.map((row) => {
    const details = (row.source_details as Record<string, unknown>) ?? {};
    return {
      id: row.id,
      versionNumber: row.version_number,
      contentHash: row.content_hash,
      status: row.status,
      errorMessage: row.error_message,
      chunkCount: typeof details.chunkCount === 'number' ? details.chunkCount : 0,
      characterCount:
        typeof details.characterCount === 'number'
          ? details.characterCount
          : typeof details.rawText === 'string'
          ? details.rawText.length
          : 0,
      isCurrent: row.id === activeVersionId,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });

  const currentVerSummary = versionSummaries.find((v) => v.id === activeVersionId) ?? versionSummaries[0];

  return {
    id: targetDoc!.id,
    organizationId: targetDoc!.organization_id,
    createdBy: targetDoc!.created_by,
    name: targetDoc!.name,
    sourceType: targetDoc!.source_type,
    currentVersionId: activeVersionId,
    status: currentVerSummary?.status ?? finalStatus,
    currentVersion: currentVerSummary,
    versions: versionSummaries,
    sourceDetails: {
      originalFilename: validated.filename,
      mimeType: validated.mimeType,
      fileSizeBytes: validated.sizeBytes,
      characterCount: sourceDetailsPayload.characterCount as number | undefined,
      wordCount: sourceDetailsPayload.wordCount as number | undefined,
      pageCount: sourceDetailsPayload.pageCount as number | undefined,
      chunkCount: sourceDetailsPayload.chunkCount as number | undefined,
    },
    createdAt: targetDoc!.created_at.toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Lists documents belonging to the active organization with pagination
 * and stable ordering.
 */
export async function listDocuments(
  params: ListDocumentsParams
): Promise<ListDocumentsResult> {
  const { organizationId, page = 1, limit = 20, sourceType, status } = params;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['d.organization_id = $1'];
  const values: unknown[] = [organizationId];
  let paramIdx = 2;

  if (sourceType) {
    conditions.push(`d.source_type = $${paramIdx++}`);
    values.push(sourceType);
  }

  if (status) {
    conditions.push(`dv.status = $${paramIdx++}`);
    values.push(status);
  }

  const whereClause = conditions.join(' AND ');

  // Get total count
  const countRes = await query<{ count: string }>(
    `SELECT count(d.id)
     FROM documents d
     LEFT JOIN document_versions dv ON dv.id = d.current_version_id
     WHERE ${whereClause}`,
    values
  );
  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

  // Get paginated rows
  const queryValues = [...values, limit, offset];
  const rowsRes = await query<DocumentRow>(
    `SELECT d.id, d.organization_id, d.created_by, d.name, d.source_type, d.current_version_id,
            d.created_at, d.updated_at,
            dv.version_number, dv.content_hash, dv.status, dv.error_message
     FROM documents d
     LEFT JOIN document_versions dv ON dv.id = d.current_version_id
     WHERE ${whereClause}
     ORDER BY d.created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    queryValues
  );

  const documents: DocumentResponse[] = rowsRes.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    name: row.name,
    sourceType: row.source_type,
    currentVersionId: row.current_version_id,
    status: row.status ?? 'queued',
    currentVersion: row.current_version_id
      ? {
          id: row.current_version_id,
          versionNumber: row.version_number ?? 1,
          contentHash: row.content_hash ?? '',
          status: row.status ?? 'queued',
          errorMessage: row.error_message,
          isCurrent: true,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        }
      : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    documents,
    total,
    page,
    limit,
    totalPages,
  };
}

/**
 * Retrieves a document, its current version status, and its version history.
 * Enforces organization membership and returns 404 for non-members
 * to prevent existence disclosure.
 */
export async function getDocumentById(
  documentId: string,
  callerUserId: string
): Promise<DocumentDetailResponse> {
  const docRes = await query<DocumentRow>(
    `SELECT d.id, d.organization_id, d.created_by, d.name, d.source_type, d.current_version_id,
            d.created_at, d.updated_at,
            dv.version_number, dv.content_hash, dv.status, dv.error_message, dv.source_details
     FROM documents d
     LEFT JOIN document_versions dv ON dv.id = d.current_version_id
     WHERE d.id = $1`,
    [documentId]
  );

  const row = docRes.rows[0];
  if (!row) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  // Verify caller membership in the document's organization
  const member = await getOrganizationMember(row.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const sourceDetails = (row.source_details as Record<string, unknown>) ?? {};

  // Fetch all versions for this document
  const versionsRes = await query<{
    id: string;
    version_number: number;
    content_hash: string;
    status: DocumentStatus;
    error_message: string | null;
    source_details: Record<string, unknown> | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, version_number, content_hash, status, error_message, source_details, created_at, updated_at
     FROM document_versions
     WHERE document_id = $1
     ORDER BY version_number DESC`,
    [documentId]
  );

  const versions: DocumentVersionSummary[] = versionsRes.rows.map((v) => {
    const vDetails = (v.source_details as Record<string, unknown>) ?? {};
    return {
      id: v.id,
      versionNumber: v.version_number,
      contentHash: v.content_hash,
      status: v.status,
      errorMessage: v.error_message,
      chunkCount: typeof vDetails.chunkCount === 'number' ? vDetails.chunkCount : 0,
      characterCount:
        typeof vDetails.characterCount === 'number'
          ? vDetails.characterCount
          : typeof vDetails.rawText === 'string'
          ? vDetails.rawText.length
          : 0,
      isCurrent: v.id === row.current_version_id,
      createdAt: v.created_at.toISOString(),
      updatedAt: v.updated_at.toISOString(),
    };
  });

  const versionSummary: DocumentVersionSummary | undefined = row.current_version_id
    ? {
        id: row.current_version_id,
        versionNumber: row.version_number ?? 1,
        contentHash: row.content_hash ?? '',
        status: row.status ?? 'queued',
        errorMessage: row.error_message,
        chunkCount: typeof sourceDetails.chunkCount === 'number' ? sourceDetails.chunkCount : 0,
        characterCount:
          typeof sourceDetails.characterCount === 'number'
            ? sourceDetails.characterCount
            : typeof sourceDetails.rawText === 'string'
            ? sourceDetails.rawText.length
            : 0,
        isCurrent: true,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }
    : undefined;

  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    name: row.name,
    sourceType: row.source_type,
    currentVersionId: row.current_version_id,
    status: row.status ?? 'queued',
    currentVersion: versionSummary,
    versions,
    sourceDetails: {
      originalFilename: sourceDetails.originalFilename as string | undefined,
      mimeType: sourceDetails.mimeType as string | undefined,
      fileSizeBytes: sourceDetails.fileSizeBytes as number | undefined,
      characterCount: sourceDetails.characterCount as number | undefined,
      wordCount: sourceDetails.wordCount as number | undefined,
      pageCount: sourceDetails.pageCount as number | undefined,
      chunkCount: sourceDetails.chunkCount as number | undefined,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Lists all immutable versions for a document.
 */
export async function listDocumentVersions(
  documentId: string,
  callerUserId: string
): Promise<DocumentVersionListResponse> {
  const docRes = await query<{ id: string; organization_id: string; current_version_id: string | null }>(
    'SELECT id, organization_id, current_version_id FROM documents WHERE id = $1',
    [documentId]
  );
  const doc = docRes.rows[0];
  if (!doc) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const member = await getOrganizationMember(doc.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const versionsRes = await query<{
    id: string;
    version_number: number;
    content_hash: string;
    status: DocumentStatus;
    error_message: string | null;
    source_details: Record<string, unknown> | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, version_number, content_hash, status, error_message, source_details, created_at, updated_at
     FROM document_versions
     WHERE document_id = $1
     ORDER BY version_number DESC`,
    [documentId]
  );

  const versions: DocumentVersionSummary[] = versionsRes.rows.map((row) => {
    const details = (row.source_details as Record<string, unknown>) ?? {};
    return {
      id: row.id,
      versionNumber: row.version_number,
      contentHash: row.content_hash,
      status: row.status,
      errorMessage: row.error_message,
      chunkCount: typeof details.chunkCount === 'number' ? details.chunkCount : 0,
      characterCount:
        typeof details.characterCount === 'number'
          ? details.characterCount
          : typeof details.rawText === 'string'
          ? details.rawText.length
          : 0,
      isCurrent: row.id === doc.current_version_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });

  return {
    documentId: doc.id,
    currentVersionId: doc.current_version_id,
    versions,
  };
}

/**
 * Re-indexes a specific or current version of a document safely and idempotently.
 */
export type ChunkingConfigOverride = {
  maxChunkSizeChars?: number | undefined;
  chunkOverlapChars?: number | undefined;
  minChunkSizeChars?: number | undefined;
};

export async function reindexDocument(params: {
  documentId: string;
  versionId?: string | undefined;
  callerUserId: string;
  config?: ChunkingConfigOverride | undefined;
  provider?: EmbeddingProvider | undefined;
}): Promise<DocumentReindexResponse> {
  const { documentId, versionId, callerUserId, config, provider } = params;

  const docRes = await query<{ id: string; organization_id: string; current_version_id: string | null }>(
    'SELECT id, organization_id, current_version_id FROM documents WHERE id = $1',
    [documentId]
  );
  const doc = docRes.rows[0];
  if (!doc) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const member = await getOrganizationMember(doc.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  if (!hasMinimumRole(member.role, 'member')) {
    throw new DocError(
      'Forbidden: Member role or higher is required to re-index documents.',
      403,
      'FORBIDDEN'
    );
  }

  const targetVersionId = versionId || doc.current_version_id;
  if (!targetVersionId) {
    throw new DocError('Document has no active version to re-index', 400, 'NO_DOCUMENT_VERSION');
  }

  const versionRes = await query<{
    id: string;
    version_number: number;
    status: DocumentStatus;
    source_details: Record<string, unknown> | null;
  }>(
    'SELECT id, version_number, status, source_details FROM document_versions WHERE id = $1 AND document_id = $2',
    [targetVersionId, documentId]
  );
  const versionRow = versionRes.rows[0];
  if (!versionRow) {
    throw new DocError('Document version not found', 404, 'VERSION_NOT_FOUND');
  }

  const sourceDetails = (versionRow.source_details as Record<string, unknown>) ?? {};
  if (typeof sourceDetails.rawText !== 'string' || sourceDetails.rawText.trim().length === 0) {
    const noTextMessage = 'Document version has no extracted text available for re-indexing';
    await query(
      `UPDATE document_versions
       SET status = 'failed',
           error_message = $1,
           updated_at = now()
       WHERE id = $2`,
      [noTextMessage, targetVersionId]
    );

    throw new DocError(
      noTextMessage,
      400,
      'NO_EXTRACTED_TEXT'
    );
  }

  try {
    const ingestRes = await ingestDocumentVersion({
      documentId: doc.id,
      documentVersionId: targetVersionId,
      organizationId: doc.organization_id,
      ...(config ? { config } : {}),
      ...(provider ? { provider } : {}),
    });

    return {
      success: true,
      documentId: doc.id,
      versionId: targetVersionId,
      status: 'ready',
      chunkCount: ingestRes.chunkCount,
      totalCharacters: ingestRes.totalCharacters,
      totalEstimatedTokens: ingestRes.totalEstimatedTokens,
      embeddingModel: ingestRes.embeddingModel,
      reindexedAt: new Date().toISOString(),
    };
  } catch (err) {
    // If re-indexing failed, mark version as failed in DB
    const errorMsg = err instanceof Error ? err.message : 'Re-indexing failed';
    await query(
      `UPDATE document_versions
       SET status = 'failed',
           error_message = $1,
           updated_at = now()
       WHERE id = $2`,
      [errorMsg, targetVersionId]
    );

    if (err instanceof IngestionError) {
      throw new DocError(err.message, err.statusCode, 'INGESTION_FAILED', { stage: err.stage });
    }
    throw new DocError(errorMsg, 500, 'REINDEX_FAILED');
  }
}

/**
 * Activates an existing ready version of a document.
 */
export async function activateDocumentVersion(params: {
  documentId: string;
  versionId: string;
  callerUserId: string;
}): Promise<ActivateVersionResponse> {
  const { documentId, versionId, callerUserId } = params;

  const docRes = await query<{ id: string; organization_id: string; current_version_id: string | null }>(
    'SELECT id, organization_id, current_version_id FROM documents WHERE id = $1',
    [documentId]
  );
  const doc = docRes.rows[0];
  if (!doc) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const member = await getOrganizationMember(doc.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  if (!hasMinimumRole(member.role, 'member')) {
    throw new DocError(
      'Forbidden: Member role or higher is required to activate document versions.',
      403,
      'FORBIDDEN'
    );
  }

  const versionRes = await query<{ id: string; status: DocumentStatus; version_number: number }>(
    'SELECT id, status, version_number FROM document_versions WHERE id = $1 AND document_id = $2',
    [versionId, documentId]
  );
  const targetVersion = versionRes.rows[0];
  if (!targetVersion) {
    throw new DocError('Document version not found', 404, 'VERSION_NOT_FOUND');
  }

  if (targetVersion.status !== 'ready') {
    throw new DocError(
      `Cannot activate version ${targetVersion.version_number}: version status is "${targetVersion.status}", expected "ready".`,
      400,
      'CANNOT_ACTIVATE_NON_READY_VERSION'
    );
  }

  const previousVersionId = doc.current_version_id;
  await query(
    'UPDATE documents SET current_version_id = $1, updated_at = now() WHERE id = $2',
    [versionId, documentId]
  );

  return {
    success: true,
    documentId,
    previousVersionId,
    currentVersionId: versionId,
    message: `Version ${targetVersion.version_number} is now the active version.`,
  };
}

/**
 * Deletes a document. Requires Admin role.
 */
export async function deleteDocument(
  documentId: string,
  callerUserId: string
): Promise<{ success: boolean; message: string }> {
  const docRes = await query<{ id: string; organization_id: string }>(
    'SELECT id, organization_id FROM documents WHERE id = $1',
    [documentId]
  );

  const doc = docRes.rows[0];
  if (!doc) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const member = await getOrganizationMember(doc.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  if (member.role !== 'admin') {
    throw new DocError(
      'Forbidden: Only administrators can delete documents from this organization',
      403,
      'FORBIDDEN'
    );
  }

  await query('DELETE FROM documents WHERE id = $1', [documentId]);

  return {
    success: true,
    message: 'Document deleted successfully',
  };
}
