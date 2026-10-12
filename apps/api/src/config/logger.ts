import type { FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ApiEnv } from './env.js';

/**
 * Returns Fastify server options for structured Pino logging,
 * correlation ID / request ID tracking, and sensitive data redaction.
 */
export function getLoggerOptions(env: ApiEnv): FastifyServerOptions {
  return {
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const headerId = req.headers['x-request-id'];
      if (typeof headerId === 'string' && headerId.trim().length > 0) {
        return headerId.trim();
      }
      return randomUUID();
    },
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'headers.authorization',
          'headers.cookie',
          'authorization',
          'cookie',
          'password',
          'token',
          'secret',
          'apiKey',
          'apiKey.*',
          '*.password',
          '*.token',
          '*.secret',
          '*.apiKey',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          return {
            id: request.id,
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
        res(reply) {
          return {
            statusCode: reply.statusCode,
          };
        },
        err(error) {
          return {
            type: error.name,
            message: error.message,
            stack: (env.NODE_ENV === 'production' ? '' : error.stack) ?? '',
          };
        },
      },
    },
  };
}
