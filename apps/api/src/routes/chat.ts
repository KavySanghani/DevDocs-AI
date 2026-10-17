import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateChatMessageRequestSchema,
  CreateChatSessionRequestSchema,
} from '@devdocs/shared';
import { authenticate } from '../middleware/auth.js';
import { getUserOrganizations } from '../services/organizationService.js';
import {
  ChatError,
  createChatSession,
  getChatSession,
  getChunkSource,
  listChatSessions,
  postChatMessage,
} from '../services/chat/index.js';
import { LLMError } from '../services/generation/types.js';
import { RetrievalError } from '../services/retrieval/index.js';

interface SessionParams {
  id: string;
}

interface SourceParams {
  chunkId: string;
}

interface ChunkParams {
  id: string;
}

interface SessionQuery {
  organizationId?: string;
  page?: string;
  limit?: string;
}

/**
 * Resolves active organization ID from query, header, or user's primary organization.
 */
async function resolveOrganizationId(
  request: FastifyRequest,
  explicitOrgId?: string
): Promise<string | null> {
  if (explicitOrgId) return explicitOrgId;

  const headerOrgId = request.headers['x-organization-id'];
  if (typeof headerOrgId === 'string' && headerOrgId.trim()) {
    return headerOrgId.trim();
  }

  const userOrgs = await getUserOrganizations(request.user!.userId);
  if (userOrgs.length > 0 && userOrgs[0]?.id) {
    return userOrgs[0].id;
  }

  return null;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // All chat routes require JWT authentication
  app.addHook('preHandler', authenticate);

  // POST /sessions - Create a new chat session
  app.post('/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parseResult = CreateChatSessionRequestSchema.safeParse(request.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid session input',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      const body = parseResult.data;
      const organizationId = await resolveOrganizationId(request, body.organizationId);

      if (!organizationId) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_ORGANIZATION',
            message: 'An organization ID is required to create a chat session.',
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      const session = await createChatSession({
        organizationId,
        userId: request.user!.userId,
        title: body.title,
      });

      return reply.status(201).send(session);
    } catch (err) {
      if (err instanceof ChatError) {
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

  // GET /sessions - List user's sessions in the active organization
  app.get<{ Querystring: SessionQuery }>('/sessions', async (request, reply) => {
    try {
      const organizationId = await resolveOrganizationId(request, request.query.organizationId);
      if (!organizationId) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_ORGANIZATION',
            message: 'An organization ID is required to list chat sessions.',
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      const page = request.query.page ? parseInt(request.query.page, 10) : 1;
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;

      const result = await listChatSessions({
        organizationId,
        userId: request.user!.userId,
        page: isNaN(page) ? 1 : page,
        limit: isNaN(limit) ? 20 : limit,
      });

      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof ChatError) {
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

  // GET /sessions/:id - Get session detail and full conversation history with citations
  app.get<{ Params: SessionParams; Querystring: { organizationId?: string } }>(
    '/sessions/:id',
    async (request, reply) => {
      try {
        const result = await getChatSession(
          request.params.id,
          request.user!.userId,
          request.query.organizationId
        );
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof ChatError) {
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

  // GET /sessions/:id/messages - Get messages list for a session
  app.get<{ Params: SessionParams; Querystring: { organizationId?: string } }>(
    '/sessions/:id/messages',
    async (request, reply) => {
      try {
        const result = await getChatSession(
          request.params.id,
          request.user!.userId,
          request.query.organizationId
        );
        return reply.status(200).send({ messages: result.messages });
      } catch (err) {
        if (err instanceof ChatError) {
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

  // POST /sessions/:id/messages - Submit a user question, generate grounded response, validate citations
  app.post<{ Params: SessionParams }>('/sessions/:id/messages', async (request, reply) => {
    try {
      const parseResult = CreateChatMessageRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid message parameters',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      const body = parseResult.data;
      const turnResponse = await postChatMessage({
        sessionId: request.params.id,
        userId: request.user!.userId,
        content: body.content,
        mode: body.mode,
        topK: body.topK,
        documentId: body.documentId,
        maxContextChars: body.maxContextChars,
      });

      return reply.status(200).send(turnResponse);
    } catch (err) {
      if (err instanceof ChatError) {
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

  // GET /sources/:chunkId - Inspect full chunk source context for citation clicks
  app.get<{ Params: SourceParams }>('/sources/:chunkId', async (request, reply) => {
    try {
      const source = await getChunkSource(request.params.chunkId, request.user!.userId);
      return reply.status(200).send(source);
    } catch (err) {
      if (err instanceof ChatError) {
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

  // GET /chunks/:id - Alias for source chunk inspection
  app.get<{ Params: ChunkParams }>('/chunks/:id', async (request, reply) => {
    try {
      const source = await getChunkSource(request.params.id, request.user!.userId);
      return reply.status(200).send(source);
    } catch (err) {
      if (err instanceof ChatError) {
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
