import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse } from '@devdocs/shared';

/**
 * Registers standardized error handlers on the Fastify instance.
 * Ensures consistent error envelopes and prevents leaking stack traces/secrets.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  // Centralized Error Handler
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;

    // Log the error with request context
    request.log.error(
      {
        err: error,
        requestId: request.id,
        statusCode,
        url: request.url,
        method: request.method,
      },
      `Request error: ${error.message}`
    );

    const isProduction = process.env.NODE_ENV === 'production';
    const isClientError = statusCode < 500;

    // Safe error message for response
    const message = isClientError || !isProduction
      ? error.message
      : 'An unexpected internal server error occurred';

    const code = error.code ?? (statusCode === 404 ? 'NOT_FOUND' : statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');

    const responsePayload: ApiErrorResponse = {
      error: {
        code,
        message,
        statusCode,
        requestId: request.id,
        details: !isProduction && error.stack ? { stack: error.stack } : undefined,
      },
    };

    void reply.status(statusCode).send(responsePayload);
  });

  // Not Found (404) Handler
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    request.log.warn({ requestId: request.id, url: request.url }, 'Route not found');

    const responsePayload: ApiErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404,
        requestId: request.id,
      },
    };

    void reply.status(404).send(responsePayload);
  });
}
