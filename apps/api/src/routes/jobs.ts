import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { getJobById, JobError } from '../services/jobs/jobService.js';

interface JobParams {
  id: string;
}

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  // All job routes require authentication
  app.addHook('preHandler', authenticate);

  // GET /:id - Get job status and progress details with organization scoping
  app.get<{ Params: JobParams }>('/:id', async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
    try {
      const job = await getJobById(request.params.id, request.user!.userId);
      return reply.status(200).send({ job });
    } catch (err) {
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
  });
}
