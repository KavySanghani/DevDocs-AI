import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DocumentListQuerySchema,
  hasMinimumRole,
} from '@devdocs/shared';
import { getEnv } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { getOrganizationMember } from '../services/organizationService.js';
import {
  deleteDocument,
  DocError,
  getDocumentById,
  listDocuments,
  uploadAndProcessDocument,
} from '../services/documentService.js';
import { ValidationError } from '../services/documentValidation.js';

interface DocParams {
  id: string;
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // All document routes require authentication
  app.addHook('preHandler', authenticate);

  // POST / - Upload and process a document
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
    const headerOrgId = request.headers['x-organization-id'] as string | undefined;
    const queryOrgId = (request.query as { organizationId?: string })?.organizationId;

    const organizationId = formOrgId || headerOrgId || queryOrgId;

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

  // GET /:id - Retrieve safe metadata and processing status of a document
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
}
