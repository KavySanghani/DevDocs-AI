import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '@devdocs/db';
import {
  AddMemberRequestSchema,
  CreateOrganizationRequestSchema,
  UpdateMemberRoleRequestSchema,
  VectorSearchRequestSchema,
  SearchRequestSchema,
  RAGQueryRequestSchema,
} from '@devdocs/shared';
import { authenticate, requireOrgRole } from '../middleware/auth.js';
import {
  OrgError,
  addOrganizationMember,
  createOrganization,
  getOrganizationDetails,
  getUserOrganizations,
  listOrganizationMembers,
  removeOrganizationMember,
  updateMemberRole,
} from '../services/organizationService.js';
import { uploadAndProcessDocument } from '../services/documentService.js';
import { searchSimilarChunks, searchHybridChunks, RetrievalError } from '../services/retrieval/index.js';
import { queryRAG, LLMError } from '../services/generation/index.js';

interface OrgParams {
  orgId: string;
}

interface OrgMemberParams {
  orgId: string;
  userId: string;
}

interface OrgDocParams {
  orgId: string;
  docId: string;
}

const CreateDocRequestSchema = z.object({
  name: z.string().min(1, 'Document name is required'),
  sourceType: z.enum(['pdf', 'markdown', 'text', 'github']),
});

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  // All organization routes require basic authentication
  app.addHook('preHandler', authenticate);

  // POST / - Create a new organization workspace
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = CreateOrganizationRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid organization input',
          statusCode: 400,
          requestId: request.id,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const { name, slug } = parseResult.data;
      const organization = await createOrganization(request.user!.userId, name, slug);
      return reply.status(201).send({ organization });
    } catch (err) {
      if (err instanceof OrgError) {
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

  // GET / - List all organizations the authenticated user belongs to
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const organizations = await getUserOrganizations(request.user!.userId);
    return reply.status(200).send({ organizations });
  });

  // GET /:orgId - Retrieve organization details (Requires viewer or higher)
  app.get<{ Params: OrgParams }>(
    '/:orgId',
    { preHandler: [requireOrgRole('viewer')] },
    async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      try {
        const organization = await getOrganizationDetails(
          request.params.orgId,
          request.user!.userId
        );
        return reply.status(200).send({ organization });
      } catch (err) {
        if (err instanceof OrgError) {
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
    }
  );

  // GET /:orgId/members - List members of an organization (Requires viewer or higher)
  app.get<{ Params: OrgParams }>(
    '/:orgId/members',
    { preHandler: [requireOrgRole('viewer')] },
    async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      try {
        const members = await listOrganizationMembers(
          request.params.orgId,
          request.user!.userId
        );
        return reply.status(200).send({ members });
      } catch (err) {
        if (err instanceof OrgError) {
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
    }
  );

  // POST /:orgId/members - Add an existing registered user to the organization (Admin only)
  app.post<{ Params: OrgParams }>(
    '/:orgId/members',
    { preHandler: [requireOrgRole('admin')] },
    async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      const parseResult = AddMemberRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid member input',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      try {
        const { email, role } = parseResult.data;
        const member = await addOrganizationMember(
          request.params.orgId,
          request.user!.userId,
          email,
          role
        );
        return reply.status(201).send({ member });
      } catch (err) {
        if (err instanceof OrgError) {
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
    }
  );

  // PATCH /:orgId/members/:userId - Update a member's role (Admin only)
  app.patch<{ Params: OrgMemberParams }>(
    '/:orgId/members/:userId',
    { preHandler: [requireOrgRole('admin')] },
    async (request: FastifyRequest<{ Params: OrgMemberParams }>, reply: FastifyReply) => {
      const parseResult = UpdateMemberRoleRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid role update input',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      try {
        const { role } = parseResult.data;
        const member = await updateMemberRole(
          request.params.orgId,
          request.user!.userId,
          request.params.userId,
          role
        );
        return reply.status(200).send({ member });
      } catch (err) {
        if (err instanceof OrgError) {
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
    }
  );

  // DELETE /:orgId/members/:userId - Remove member from organization (Admin or self-removal)
  app.delete<{ Params: OrgMemberParams }>(
    '/:orgId/members/:userId',
    { preHandler: [requireOrgRole('viewer')] },
    async (request: FastifyRequest<{ Params: OrgMemberParams }>, reply: FastifyReply) => {
      try {
        const result = await removeOrganizationMember(
          request.params.orgId,
          request.user!.userId,
          request.params.userId
        );
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof OrgError) {
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
    }
  );

  // ============================================================================
  // RBAC Demonstration & Resource Tenant Isolation Endpoints
  // Used to verify that Admin, Member, and Viewer permissions strictly work
  // and cross-tenant access is rejected without disclosure.
  // ============================================================================

  // POST /:orgId/documents - Create/upload document (Admin or Member only; Viewer rejected with 403)
  app.post<{ Params: OrgParams }>(
    '/:orgId/documents',
    { preHandler: [requireOrgRole('member')] },
    async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      if (request.isMultipart()) {
        const uploadData = await request.file();
        if (!uploadData) {
          return reply.status(400).send({
            error: {
              code: 'MISSING_FILE',
              message: 'No file provided in multipart upload.',
              statusCode: 400,
              requestId: request.id,
            },
          });
        }
        const buffer = await uploadData.toBuffer();
        const fields = uploadData.fields as Record<string, { value?: string }>;
        const customName = fields?.name?.value;
        const doc = await uploadAndProcessDocument({
          organizationId: request.params.orgId,
          userId: request.user!.userId,
          filename: uploadData.filename,
          buffer,
          declaredMimeType: uploadData.mimetype,
          customName,
        });
        return reply.status(201).send({ document: doc });
      }

      const parseResult = CreateDocRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid document input',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      const { name, sourceType } = parseResult.data;
      const res = await query<{
        id: string;
        organization_id: string;
        created_by: string;
        name: string;
        source_type: string;
        created_at: Date;
      }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, organization_id, created_by, name, source_type, created_at`,
        [request.params.orgId, request.user!.userId, name, sourceType]
      );

      const doc = res.rows[0]!;
      return reply.status(201).send({
        document: {
          id: doc.id,
          organizationId: doc.organization_id,
          createdBy: doc.created_by,
          name: doc.name,
          sourceType: doc.source_type,
          createdAt: doc.created_at.toISOString(),
        },
      });
    }
  );

  // GET /:orgId/documents - List documents in organization (Admin, Member, Viewer allowed; non-member 404)
  app.get<{ Params: OrgParams }>(
    '/:orgId/documents',
    { preHandler: [requireOrgRole('viewer')] },
    async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
      // Scoped strictly to the active organization
      const res = await query<{
        id: string;
        organization_id: string;
        name: string;
        source_type: string;
        created_at: Date;
      }>(
        `SELECT id, organization_id, name, source_type, created_at
         FROM documents
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [request.params.orgId]
      );

      return reply.status(200).send({
        documents: res.rows.map((d) => ({
          id: d.id,
          organizationId: d.organization_id,
          name: d.name,
          sourceType: d.source_type,
          createdAt: d.created_at.toISOString(),
        })),
      });
    }
  );

  // DELETE /:orgId/documents/:docId - Delete document (Admin only; Member & Viewer rejected with 403)
  app.delete<{ Params: OrgDocParams }>(
    '/:orgId/documents/:docId',
    { preHandler: [requireOrgRole('admin')] },
    async (request: FastifyRequest<{ Params: OrgDocParams }>, reply: FastifyReply) => {
      // Scoped strictly to the active organization to prevent cross-tenant deletion
      const res = await query<{ id: string }>(
        'DELETE FROM documents WHERE id = $1 AND organization_id = $2 RETURNING id',
        [request.params.docId, request.params.orgId]
      );

      if (res.rows.length === 0) {
        return reply.status(404).send({
          error: {
            code: 'DOCUMENT_NOT_FOUND',
            message: 'Document not found in this organization',
            statusCode: 404,
            requestId: request.id,
          },
        });
      }

      return reply.status(200).send({ success: true, message: 'Document deleted successfully' });
    }
  );

  // POST /:orgId/retrieval/vector - Dedicated semantic vector search
  const handleVectorSearch = async (
    request: FastifyRequest<{ Params: OrgParams }>,
    reply: FastifyReply
  ) => {
    const parseResult = VectorSearchRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid vector search parameters',
          statusCode: 400,
          requestId: request.id,
          details: parseResult.error.issues,
        },
      });
    }

    try {
      const result = await searchSimilarChunks({
        organizationId: request.params.orgId,
        ...parseResult.data,
      });

      return reply.status(200).send(result);
    } catch (err) {
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
  };

  // POST /:orgId/search - Unified hybrid/keyword/vector search (defaults to hybrid)
  const handleHybridSearch = async (
    request: FastifyRequest<{ Params: OrgParams }>,
    reply: FastifyReply
  ) => {
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

    try {
      const body = parseResult.data;
      const result = await searchHybridChunks({
        organizationId: request.params.orgId,
        query: body.query,
        mode: body.retrievalMode ?? body.mode,
        topK: body.topK,
        candidateCount: body.candidateCount,
        documentId: body.documentId,
        similarityThreshold: body.similarityThreshold,
        rrfK: body.rrfK,
        metadataFilter: body.metadataFilter,
      });

      return reply.status(200).send(result);
    } catch (err) {
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
  };

  app.post<{ Params: OrgParams }>(
    '/:orgId/search',
    { preHandler: [requireOrgRole('viewer')] },
    handleHybridSearch
  );

  app.post<{ Params: OrgParams }>(
    '/:orgId/retrieval/vector',
    { preHandler: [requireOrgRole('viewer')] },
    handleVectorSearch
  );

  // POST /:orgId/query & POST /:orgId/rag/query - Grounded RAG query
  const handleRAGQuery = async (
    request: FastifyRequest<{ Params: OrgParams }>,
    reply: FastifyReply
  ) => {
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

    try {
      const result = await queryRAG({
        organizationId: request.params.orgId,
        ...parseResult.data,
      });

      return reply.status(200).send(result);
    } catch (err) {
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
  };

  app.post<{ Params: OrgParams }>(
    '/:orgId/query',
    { preHandler: [requireOrgRole('viewer')] },
    handleRAGQuery
  );

  app.post<{ Params: OrgParams }>(
    '/:orgId/rag/query',
    { preHandler: [requireOrgRole('viewer')] },
    handleRAGQuery
  );
}
