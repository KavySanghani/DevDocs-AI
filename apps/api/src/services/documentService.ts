import { query, withTransaction } from '@devdocs/db';
import type {
  DocumentDetailResponse,
  DocumentResponse,
  DocumentSourceType,
  DocumentStatus,
  DocumentVersionSummary,
} from '@devdocs/shared';
import { parseDocument, ParseError } from './parsers/index.js';
import { validateDocumentFile } from './documentValidation.js';
import { getOrganizationMember } from './organizationService.js';
import { ingestDocumentVersion } from './ingestion/index.js';

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
 * and parsing an engineering document.
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
  } = params;

  // 1. Validate file format, extension, size, and magic bytes
  const validated = validateDocumentFile(
    filename,
    buffer,
    declaredMimeType,
    maxSizeBytes
  );

  const documentName = customName?.trim() || validated.filename;

  // 2. Check for duplicate content hash within the active organization
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

  // 3. Atomically create document and version 1 in "queued" / "processing" state
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
    const createdVersion = versionRes.rows[0]!;

    await client.query(
      'UPDATE documents SET current_version_id = $1, updated_at = now() WHERE id = $2',
      [createdVersion.id, createdDoc.id]
    );

    return { doc: createdDoc, version: createdVersion };
  });

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
    [finalStatus, errorMessage, JSON.stringify(sourceDetailsPayload), version.id]
  );

  // 6. If parsing succeeded, run the ingestion pipeline (chunking + embeddings + vector storage)
  if (finalStatus === 'processing') {
    try {
      const ingestRes = await ingestDocumentVersion({
        documentId: doc.id,
        documentVersionId: version.id,
        organizationId: doc.organization_id,
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
    } catch (ingestErr) {
      finalStatus = 'failed';
      errorMessage =
        ingestErr instanceof Error ? ingestErr.message : 'Document ingestion pipeline failed';
    }
  }

  const versionSummary: DocumentVersionSummary = {
    id: version.id,
    versionNumber: 1,
    contentHash: validated.contentHash,
    status: finalStatus,
    errorMessage,
    createdAt: version.created_at.toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    id: doc.id,
    organizationId: doc.organization_id,
    createdBy: doc.created_by,
    name: doc.name,
    sourceType: doc.source_type,
    currentVersionId: version.id,
    status: finalStatus,
    currentVersion: versionSummary,
    sourceDetails: {
      originalFilename: validated.filename,
      mimeType: validated.mimeType,
      fileSizeBytes: validated.sizeBytes,
      characterCount: sourceDetailsPayload.characterCount as number | undefined,
      wordCount: sourceDetailsPayload.wordCount as number | undefined,
      pageCount: sourceDetailsPayload.pageCount as number | undefined,
      chunkCount: sourceDetailsPayload.chunkCount as number | undefined,
    },
    createdAt: doc.created_at.toISOString(),
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
 * Retrieves a document and its current version status.
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

  const versionSummary: DocumentVersionSummary | undefined = row.current_version_id
    ? {
        id: row.current_version_id,
        versionNumber: row.version_number ?? 1,
        contentHash: row.content_hash ?? '',
        status: row.status ?? 'queued',
        errorMessage: row.error_message,
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
