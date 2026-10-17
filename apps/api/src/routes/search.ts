import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SearchRequestSchema } from '@devdocs/shared';
import { authenticate, requireOrgRole } from '../middleware/auth.js';
import { searchHybridChunks, RetrievalError } from '../services/retrieval/index.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // PreHandler: Authenticate JWT and enforce organization viewer access
  app.addHook('preHandler', authenticate);

  /**
   * POST /search
   * Unified search endpoint supporting Hybrid, Vector, and Keyword retrieval modes.
   *
   * Request Body:
   * - query (required): string, 1-2000 chars
   * - organizationId (optional if passed via X-Organization-Id header)
   * - mode (optional): 'hybrid' | 'vector' | 'keyword' (default: 'hybrid')
   * - topK (optional): number, 1-50 (default: 5)
   * - candidateCount (optional): number, 1-100 (default: 20)
   * - documentId (optional): UUID filter
   * - similarityThreshold (optional): number, 0-1
   * - rrfK (optional): number, 1-500 (default: 60)
   * - metadataFilter (optional): JSONB key-value filter
   */
  app.post(
    '/search',
    { preHandler: [requireOrgRole('viewer')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = SearchRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search request parameters',
            statusCode: 400,
            requestId: request.id,
            details: parseResult.error.issues,
          },
        });
      }

      const body = parseResult.data;
      const organizationId =
        body.organizationId ||
        (request.headers['x-organization-id'] as string | undefined) ||
        (request.query as { orgId?: string } | undefined)?.orgId;

      if (!organizationId) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_ORGANIZATION_ID',
            message: 'Organization ID is required in body (organizationId) or header (X-Organization-Id).',
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      try {
        const result = await searchHybridChunks({
          organizationId,
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
    }
  );
}
