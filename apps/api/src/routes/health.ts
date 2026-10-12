import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from '@devdocs/shared';

const APP_VERSION = '0.1.0';

export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  /**
   * Main health endpoint providing overall application state.
   */
  app.get('/health', async (_request, reply) => {
    const payload: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: APP_VERSION,
      environment: process.env.NODE_ENV ?? 'development',
    };

    return reply.status(200).send(payload);
  });

  /**
   * Dedicated Liveness Probe (process is running).
   */
  app.get('/health/live', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  /**
   * Dedicated Readiness Probe (ready to serve incoming requests).
   * In future phases, this will check DB connectivity and queue readiness.
   */
  app.get('/health/ready', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      ready: true,
      checks: {
        api: 'ok',
      },
    });
  });
};
