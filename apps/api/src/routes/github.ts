import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  GitHubImportRequestSchema,
  type GitHubImportRequest,
} from '@devdocs/shared';
import { authenticate } from '../middleware/auth.js';
import { DocError } from '../services/documentService.js';
import { getJobById, JobError } from '../services/jobs/jobService.js';
import {
  startRepoImport,
  listRepositories,
  getRepositoryById,
  getRepositorySource,
  GitHubUrlError,
  GitHubClientError,
  GitHubRateLimitError,
} from '../services/github/index.js';

interface RepoParams {
  id: string;
}

interface SourceQuery {
  filePath?: string;
  versionId?: string;
}

interface ListReposQuery {
  organizationId?: string;
}

interface JobParams {
  id: string;
}

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  // All GitHub routes require authentication
  app.addHook('preHandler', authenticate);

  /**
   * POST /import
   * Initiates asynchronous import of a public GitHub repository.
   * Enforces Member+ RBAC and strict repository URL validation.
   */
  app.post(
    '/import',
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ) => {
      const parsed = GitHubImportRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((e) => e.message).join('; '),
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      const body: GitHubImportRequest = parsed.data;
      const organizationId =
        body.organizationId ||
        (request.headers['x-organization-id'] as string | undefined);

      if (!organizationId) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_ORGANIZATION_ID',
            message:
              'Organization ID is required (via body organizationId or X-Organization-Id header).',
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      try {
        const result = await startRepoImport({
          organizationId,
          userId: request.user!.userId,
          repoUrl: body.repoUrl,
          ref: body.ref,
          name: body.name,
        });

        return reply.status(202).send(result);
      } catch (err: unknown) {
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

        if (err instanceof GitHubUrlError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              statusCode: err.statusCode,
              requestId: request.id,
            },
          });
        }

        if (err instanceof GitHubRateLimitError) {
          return reply.status(429).send({
            error: {
              code: 'GITHUB_RATE_LIMITED',
              message: err.message,
              statusCode: 429,
              requestId: request.id,
            },
          });
        }

        if (err instanceof GitHubClientError) {
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

  /**
   * GET /repos
   * Lists all imported GitHub repositories for an organization.
   */
  app.get(
    '/repos',
    async (
      request: FastifyRequest<{ Querystring: ListReposQuery }>,
      reply: FastifyReply
    ) => {
      const organizationId =
        request.query.organizationId ||
        (request.headers['x-organization-id'] as string | undefined);

      if (!organizationId) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_ORGANIZATION_ID',
            message:
              'Organization ID is required (via organizationId query param or X-Organization-Id header).',
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      try {
        const repos = await listRepositories(
          organizationId,
          request.user!.userId
        );
        return reply.status(200).send({ data: repos });
      } catch (err: unknown) {
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
    }
  );

  /**
   * GET /repos/:id
   * Retrieves metadata and latest version details for an imported repository.
   */
  app.get<{ Params: RepoParams }>(
    '/repos/:id',
    async (request: FastifyRequest<{ Params: RepoParams }>, reply: FastifyReply) => {
      try {
        const repo = await getRepositoryById(
          request.params.id,
          request.user!.userId
        );
        return reply.status(200).send({ data: repo });
      } catch (err: unknown) {
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
    }
  );

  /**
   * GET /repos/:id/source
   * Retrieves source code lines for a specific file in an imported repository.
   * Powers the safe internal source viewer without reading un-indexed or arbitrary files.
   */
  app.get<{ Params: RepoParams; Querystring: SourceQuery }>(
    '/repos/:id/source',
    async (
      request: FastifyRequest<{ Params: RepoParams; Querystring: SourceQuery }>,
      reply: FastifyReply
    ) => {
      const { filePath, versionId } = request.query;

      if (!filePath || filePath.trim() === '') {
        return reply.status(400).send({
          error: {
            code: 'MISSING_FILE_PATH',
            message: 'Query parameter "filePath" is required.',
            statusCode: 400,
            requestId: request.id,
          },
        });
      }

      try {
        const source = await getRepositorySource({
          documentId: request.params.id,
          filePath: filePath.trim(),
          versionId: versionId?.trim(),
          callerUserId: request.user!.userId,
        });

        return reply.status(200).send({ data: source });
      } catch (err: unknown) {
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
    }
  );

  /**
   * GET /jobs/:id
   * Retrieves background import job status, progress counts, and lease state.
   */
  app.get<{ Params: JobParams }>(
    '/jobs/:id',
    async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
      try {
        const job = await getJobById(request.params.id, request.user!.userId);
        return reply.status(200).send({ job });
      } catch (err: unknown) {
        if (err instanceof JobError) {
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
