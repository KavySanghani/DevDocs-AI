import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { HealthResponseSchema, ApiErrorResponseSchema } from '@devdocs/shared';
import { validateEnv } from '../src/config/env.js';

describe('API Health and Core Infrastructure', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const testEnv = validateEnv({
      PORT: '4001',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    app = await buildApp({ env: testEnv });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 and matches HealthResponseSchema', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    const parsed = HealthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('test');
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /api/health works identically under API prefix', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
  });

  it('GET /health/live returns liveness status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /health/ready returns readiness status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.ready).toBe(true);
    expect(body.checks.api).toBe('ok');
  });

  it('preserves x-request-id header or generates one', async () => {
    const customRequestId = 'trace-id-abc-987';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': customRequestId,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns structured 404 error matching ApiErrorResponseSchema for unknown routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/unknown-endpoint-404',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    const parsed = ApiErrorResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.statusCode).toBe(404);
    expect(typeof body.error.requestId).toBe('string');
  });
});
