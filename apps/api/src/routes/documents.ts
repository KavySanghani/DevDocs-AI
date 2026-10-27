import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DocumentListQuerySchema,
  DocumentDiffQuerySchema,
  DocumentReindexRequestSchema,
  hasMinimumRole,
  SearchRequestSchema,
  RAGQueryRequestSchema,
} from '@devdocs/shared';
import { getEnv } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { getOrganizationMember } from '../services/organizationService.js';
import {
  activateDocumentVersion,
  deleteDocument,
  DocError,
  getDocumentById,
  listDocuments,
  listDocumentVersions,
  reindexDocument,
  uploadAndProcessDocument,
} from '../services/documentService.js';
import { compareDocumentVersions } from '../services/documentDiff.js';
import { ValidationError } from '../services/documentValidation.js';
import {
  getPersistedChunks,
} from '../services/ingestion/index.js';
import { searchHybridChunks, RetrievalError } from '../services/retrieval/index.js';
import { queryRAG, LLMError } from '../services/generation/index.js';

interface DocParams {
  id: string;
}

interface VersionParams {
  id: string;
  versionId: string;
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // All document routes require authentication
  app.addHook('preHandler', authenticate);

  // POST / - Upload and process a new document (or new version if documentId is provided)
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const env = getEnv();

    if (!request.isMultipart()) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Expected multipart/form-data content type for file upload.',
          statusCode: 400,
          requestId: request.id,
        },
      });
    }

    let uploadData;
    try {
      uploadData = await request.file();
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string };
      if (errorObj.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: `File size exceeds maximum allowed limit of ${(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
            statusCode: 413,
            requestId: request.id,
          },
        });
      }
      throw err;
    }

    if (!uploadData) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_FILE',
          message: 'No file provided in multipart upload (field "file" required).',
          statusCode: 400,
          requestId: request.id,
        },
      });
    }

    // Extract fields
    const fields = uploadData.fields as Record<string, { value?: string }>;
    const formOrgId = fields.organizationId?.value;
    const customName = fields.name?.value;
    const formDocId = fields.documentId?.value;
    const headerOrgId = request.headers['x-organization-id'] as string | undefined;
    const headerDocId = request.headers['x-document-id'] as string | undefined;
    const queryOrgId = (request.query as { organizationId?: string })?.organizationId;

    const organizationId = formOrgId || headerOrgId || queryOrgId;
    const documentId = formDocId || headerDocId;

    if (!organizationId) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_ORGANIZATION_ID',
          message: 'Organization ID is required (via organizationId form field, X-Organization-Id header, or query param).',
          statusCode: 400,
          requestId: request.id,
        },
      });
    }

    // Verify caller membership in the target organization
    const member = await getOrganizationMember(organizationId, request.user!.userId);
    if (!member) {
      return reply.status(404).send({
        error: {
          code: 'ORGANIZATION_NOT_FOUND',
          message: 'Organization not found or access denied.',
          statusCode: 404,
          requestId: request.id,
        },
      });
    }

    // Enforce role permission: Admin or Member can upload; Viewer is forbidden (403)
    if (!hasMinimumRole(member.role, 'member')) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Insufficient permissions. Document upload requires Member role or higher.',
          statusCode: 403,
          requestId: request.id,
        },
      });
    }

    let buffer: Buffer;
    try {
      buffer = await uploadData.toBuffer();
    } catch (err: unknown) {
      const errorObj = err as { code?: string };
      if (errorObj.code === 'FST_REQ_FILE_TOO_LARGE' || uploadData.file.truncated) {
        return reply.status(413).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: `File size exceeds maximum allowed limit of ${(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
            statusCode: 413,
            requestId: request.id,
          },
        });
      }
      throw err;
    }

    if (uploadData.file.truncated) {
      return reply.status(413).send({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File size exceeds maximum allowed limit of ${(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
          statusCode: 413,
          requestId: request.id,
        },
      });
    }

    try {
      const document = await uploadAndProcessDocument({
        organizationId,
        userId: request.user!.userId,
        filename: uploadData.filename,
        buffer,
        declaredMimeType: uploadData.mimetype,
        customName,
        maxSizeBytes: env.MAX_FILE_SIZE_BYTES,
        documentId,
      });

      return reply.status(201).send({ document });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
            details: err.details,
          },
        });
      }
      throw err;
    }
  });

  // POST /:id/versions - Upload a new version for an existing document
  app.post<{ Params: DocParams }>('/:id/versions', async (request: FastifyRequest<{ Params: DocParams }>, reply: FastifyReply) => {
    const env = getEnv();

    if (!request.isMultipart()) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Expected multipart/form-data content type for file upload.',
          statusCode: 400,
          requestId: request.id,
        },
      });
    }

    // Verify document exists and caller has access
    let doc;
    try {
      doc = await getDocumentById(request.params.id, request.user!.userId);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }

    // Verify caller role in the document's organization
    const member = await getOrganizationMember(doc.organizationId, request.user!.userId);
    if (!member || !hasMinimumRole(member.role, 'member')) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Insufficient permissions. Uploading a new document version requires Member role or higher.',
          statusCode: 403,
          requestId: request.id,
        },
      });
    }

    let uploadData;
    try {
      uploadData = await request.file();
    } catch (err: unknown) {
      const errorObj = err as { code?: string; message?: string };
      if (errorObj.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: `File size exceeds maximum allowed limit of ${(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
            statusCode: 413,
            requestId: request.id,
          },
        });
      }
      throw err;
    }

    if (!uploadData) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_FILE',
          message: 'No file provided in multipart upload (field "file" required).',
          statusCode: 400,
          requestId: request.id,
        },
      });
    }

    let buffer: Buffer;
    try {
      buffer = await uploadData.toBuffer();
    } catch (err: unknown) {
      const errorObj = err as { code?: string };
      if (errorObj.code === 'FST_REQ_FILE_TOO_LARGE' || uploadData.file.truncated) {
        return reply.status(413).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: `File size exceeds maximum allowed limit of ${(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
            statusCode: 413,
            requestId: request.id,
          },
        });
      }
      throw err;
    }

    if (uploadData.file.truncated) {
      return reply.status(413).send({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File size exceeds maximum allowed limit of ${(env.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
          statusCode: 413,
          requestId: request.id,
        },
      });
    }

    try {
      const updatedDocument = await uploadAndProcessDocument({
        organizationId: doc.organizationId,
        userId: request.user!.userId,
        filename: uploadData.filename,
        buffer,
        declaredMimeType: uploadData.mimetype,
        maxSizeBytes: env.MAX_FILE_SIZE_BYTES,
        documentId: doc.id,
      });

      return reply.status(201).send({ document: updatedDocument });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
            details: err.details,
          },
        });
      }
      throw err;
    }
  });

  // GET / - List documents belonging to the active organization
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const headerOrgId = request.headers['x-organization-id'] as string | undefined;
    const queryOrgId = (request.query as { organizationId?: string })?.organizationId;
    const organizationId = headerOrgId || queryOrgId;

    if (!organizationId) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_ORGANIZATION_ID',
          message: 'Organization ID is required (via X-Organization-Id header or organizationId query param).',
          statusCode: 400,
          requestId: request.id,
        },
      });
    }

    // Verify membership (Viewer or higher)
    const member = await getOrganizationMember(organizationId, request.user!.userId);
    if (!member) {
      return reply.status(404).send({
        error: {
          code: 'ORGANIZATION_NOT_FOUND',
          message: 'Organization not found or access denied.',
          statusCode: 404,
          requestId: request.id,
        },
      });
    }

    const parseResult = DocumentListQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid document list query parameters.',
          statusCode: 400,
          requestId: request.id,
          details: parseResult.error.issues,
        },
      });
    }

    const { page, limit, sourceType, status } = parseResult.data;
    const result = await listDocuments({
      organizationId,
      page,
      limit,
      sourceType,
      status,
    });

    return reply.status(200).send(result);
  });

  // GET /:id - Retrieve safe metadata, processing status, and version history of a document
  app.get<{ Params: DocParams }>('/:id', async (request: FastifyRequest<{ Params: DocParams }>, reply: FastifyReply) => {
    try {
      const document = await getDocumentById(request.params.id, request.user!.userId);
      return reply.status(200).send({ document });
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // GET /:id/versions - List all versions for a document
  app.get<{ Params: DocParams }>('/:id/versions', async (request: FastifyRequest<{ Params: DocParams }>, reply: FastifyReply) => {
    try {
      const result = await listDocumentVersions(request.params.id, request.user!.userId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // POST /:id/versions/:versionId/activate - Activate a ready version
  app.post<{ Params: VersionParams }>('/:id/versions/:versionId/activate', async (request: FastifyRequest<{ Params: VersionParams }>, reply: FastifyReply) => {
    try {
      const result = await activateDocumentVersion({
        documentId: request.params.id,
        versionId: request.params.versionId,
        callerUserId: request.user!.userId,
      });
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // POST /:id/reindex - Re-index a specific or current version of a document
  app.post<{
    Params: DocParams;
    Body: {
      versionId?: string;
      config?: {
        maxChunkSizeChars?: number;
        chunkOverlapChars?: number;
        minChunkSizeChars?: number;
      };
    };
  }>('/:id/reindex', async (request, reply) => {
    const parseResult = DocumentReindexRequestSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid reindex request body',
          statusCode: 400,
          requestId: request.id,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const result = await reindexDocument({
        documentId: request.params.id,
        versionId: parseResult.data.versionId,
        callerUserId: request.user!.userId,
        config: parseResult.data.config,
      });

      return reply.status(200).send({ reindex: result });
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
            details: err.details,
          },
        });
      }
      throw err;
    }
  });

  // POST /:id/ingest - Legacy alias for re-indexing a document version
  app.post<{
    Params: DocParams;
    Body: {
      versionId?: string;
      config?: {
        maxChunkSizeChars?: number;
        chunkOverlapChars?: number;
        minChunkSizeChars?: number;
      };
    };
  }>('/:id/ingest', async (request, reply) => {
    const parseResult = DocumentReindexRequestSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid ingest request body',
          statusCode: 400,
          requestId: request.id,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const result = await reindexDocument({
        documentId: request.params.id,
        versionId: parseResult.data.versionId,
        callerUserId: request.user!.userId,
        config: parseResult.data.config,
      });

      return reply.status(200).send({
        ingestion: {
          documentId: result.documentId,
          versionId: result.versionId,
          status: result.status,
          chunkCount: result.chunkCount,
          totalCharacters: result.totalCharacters,
          totalEstimatedTokens: result.totalEstimatedTokens,
          embeddingModel: result.embeddingModel,
          durationMs: 0,
        },
      });
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
            details: err.details,
          },
        });
      }
      throw err;
    }
  });

  // GET /:id/diff - Compare two versions of a document
  app.get<{
    Params: DocParams;
    Querystring: { fromVersion?: string; toVersion?: string };
  }>('/:id/diff', async (request, reply) => {
    const parseResult = DocumentDiffQuerySchema.safeParse(request.query ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid diff query parameters',
          statusCode: 400,
          requestId: request.id,
          details: parseResult.error.issues,
        },
      });
    }

    // Verify document exists and caller has read access (at least Viewer)
    let doc;
    try {
      doc = await getDocumentById(request.params.id, request.user!.userId);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }

    try {
      const diffResult = await compareDocumentVersions({
        documentId: doc.id,
        organizationId: doc.organizationId,
        fromVersion: parseResult.data.fromVersion,
        toVersion: parseResult.data.toVersion,
      });

      return reply.status(200).send(diffResult);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // DELETE /:id - Delete a document (Admin only)
  app.delete<{ Params: DocParams }>('/:id', async (request: FastifyRequest<{ Params: DocParams }>, reply: FastifyReply) => {
    try {
      const result = await deleteDocument(request.params.id, request.user!.userId);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // GET /:id/chunks - Get paginated chunks for a document
  app.get<{
    Params: DocParams;
    Querystring: { page?: string; limit?: string; versionId?: string };
  }>('/:id/chunks', async (request, reply) => {
    try {
      const doc = await getDocumentById(request.params.id, request.user!.userId);
      const versionId = request.query.versionId || doc.currentVersionId;

      if (!versionId) {
        return reply.status(200).send({
          chunks: [],
          total: 0,
          page: 1,
          limit: 20,
          totalPages: 1,
        });
      }

      const page = request.query.page ? parseInt(request.query.page, 10) : 1;
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;

      const result = await getPersistedChunks({
        documentVersionId: versionId,
        organizationId: doc.organizationId,
        page: isNaN(page) ? 1 : page,
        limit: isNaN(limit) ? 20 : limit,
      });

      return reply.status(200).send({
        chunks: result.chunks.map((c) => ({
          id: c.id,
          documentVersionId: c.document_version_id,
          chunkIndex: c.chunk_index,
          content: c.content,
          tokenCount: c.token_count,
          characterCount: c.character_count,
          pageNumber: c.page_number,
          sectionTitle: c.section_title,
          filePath: c.file_path,
          lineStart: c.line_start,
          lineEnd: c.line_end,
          metadata: c.metadata,
          createdAt: c.created_at.toISOString(),
        })),
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      });
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // POST /:id/search - Unified hybrid/keyword/vector search within a specific document
  app.post<{ Params: DocParams }>('/:id/search', async (request, reply) => {
    try {
      const doc = await getDocumentById(request.params.id, request.user!.userId);

      const parseResult = SearchRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search parameters',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      const body = parseResult.data;
      const result = await searchHybridChunks({
        organizationId: doc.organizationId,
        documentId: doc.id,
        versionId: body.versionId,
        query: body.query,
        mode: body.retrievalMode ?? body.mode,
        topK: body.topK,
        candidateCount: body.candidateCount,
        similarityThreshold: body.similarityThreshold,
        rrfK: body.rrfK,
        metadataFilter: body.metadataFilter,
      });

      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      if (err instanceof RetrievalError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });

  // POST /:id/query - Grounded RAG query within a specific document
  app.post<{ Params: DocParams }>('/:id/query', async (request, reply) => {
    try {
      const doc = await getDocumentById(request.params.id, request.user!.userId);

      const parseResult = RAGQueryRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid RAG query parameters',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      const result = await queryRAG({
        organizationId: doc.organizationId,
        documentId: doc.id,
        ...parseResult.data,
      });

      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DocError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      if (err instanceof RetrievalError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      if (err instanceof LLMError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            statusCode: err.statusCode,
            requestId: request.id,
          },
        });
      }
      throw err;
    }
  });
}
