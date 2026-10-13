import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { type ApiEnv, getEnv, setEnv } from './config/env.js';
import { getLoggerOptions } from './config/logger.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { organizationRoutes } from './routes/organizations.js';

export interface BuildAppOptions {
  env?: ApiEnv;
}

/**
 * App factory function.
 * Creates and configures the Fastify server instance.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  if (options.env) {
    setEnv(options.env);
  }
  const env = options.env ?? getEnv();
  const serverOptions = getLoggerOptions(env);

  const app = fastify(serverOptions);

  // Register Rate Limiting
  if (env.NODE_ENV === 'test') {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
      allowList: () => true,
    });
  } else {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
    });
  }

  // Register CORS
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. curl, mobile, server-to-server)
      if (!origin) {
        cb(null, true);
        return;
      }

      // Check against configured CORS_ORIGIN
      if (origin === env.CORS_ORIGIN || env.CORS_ORIGIN === '*') {
        cb(null, true);
        return;
      }

      // In development, permit localhost ports
      if (env.NODE_ENV === 'development' && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
        cb(null, true);
        return;
      }

      cb(new Error(`Origin ${origin} not allowed by CORS policy`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Register custom error handler
  registerErrorHandler(app);

  // Register routes
  await app.register(healthRoutes);
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(organizationRoutes, { prefix: '/api/organizations' });

  return app;
}
