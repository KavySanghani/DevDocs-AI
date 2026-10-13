import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { getPool, closePool } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

// Validate test target before running
validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

describe('Authentication & Token Lifecycle API', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_api_suite_32_characters!';

  beforeAll(async () => {
    // Reset clean test schema on dedicated test database
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4002',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
    });

    app = await buildApp({ env: testEnv });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. User Registration', () => {
    it('successfully registers a new user with valid email and password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'engineer@example.com',
          password: 'Password123!',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      expect(body.user).toBeDefined();
      expect(body.user.id).toBeDefined();
      expect(body.user.email).toBe('engineer@example.com');
      expect(body.user.accountStatus).toBe('active');
      expect(body.token).toBeDefined();
      expect(body.expiresIn).toBe(86400);

      // Verify password_hash is NEVER returned in API response
      expect(body.user.password_hash).toBeUndefined();
      expect(body.user.password).toBeUndefined();

      // Verify stored password hash in database is bcrypt hash and not plaintext
      const pool = getPool(TEST_DATABASE_URL);
      const dbCheck = await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE email = $1',
        ['engineer@example.com']
      );
      expect(dbCheck.rows.length).toBe(1);
      const hash = dbCheck.rows[0]!.password_hash;
      expect(hash).not.toBe('Password123!');
      expect(hash).toMatch(/^\$2[aby]\$\d+\$/);
    });

    it('rejects duplicate email registration with 409 Conflict', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'engineer@example.com', // Duplicate
          password: 'AnotherPassword456!',
        },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects registration with invalid email format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'not-an-email',
          password: 'Password123!',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects registration with password shorter than 8 characters', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'shortpass@example.com',
          password: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('2. User Login & Credential Verification', () => {
    it('successfully logs in with correct credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'engineer@example.com',
          password: 'Password123!',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user.email).toBe('engineer@example.com');
      expect(body.token).toBeDefined();
      expect(body.expiresIn).toBe(86400);
    });

    it('rejects login with incorrect password with 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'engineer@example.com',
          password: 'WrongPassword!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      // Generic message prevents credential discovery
      expect(body.error.message).toBe('Invalid email or password');
    });

    it('rejects login for non-existent email with generic 401 Unauthorized', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'AnyPassword!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      expect(body.error.message).toBe('Invalid email or password');
    });
  });

  describe('3. Protected Route & Token Verification (/api/auth/me)', () => {
    let validToken: string;

    beforeAll(async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'engineer@example.com',
          password: 'Password123!',
        },
      });
      const body = JSON.parse(loginRes.body);
      validToken = body.token;
    });

    it('retrieves current user profile with valid Bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('engineer@example.com');
      expect(body.organizations).toBeDefined();
      expect(Array.isArray(body.organizations)).toBe(true);
    });

    it('rejects access when Authorization header is omitted', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects access with malformed Authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: 'NotBearerToken',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects access with token signed by an untrusted secret', async () => {
      const rogueToken = jwt.sign(
        { userId: 'fake-id', email: 'rogue@example.com', jti: 'fake-jti' },
        'wrong_untrusted_secret_key_1234567890'
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: `Bearer ${rogueToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('INVALID_TOKEN');
    });

    it('rejects access with an expired token', async () => {
      const expiredToken = jwt.sign(
        { userId: 'fake-id', email: 'expired@example.com', jti: 'fake-jti' },
        testSecret,
        { expiresIn: '-1s' }
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: `Bearer ${expiredToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('TOKEN_EXPIRED');
    });
  });

  describe('4. Token Revocation & Logout Behavior', () => {
    it('revokes token on logout and rejects subsequent requests with that token', async () => {
      // 1. Obtain a fresh token via login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'engineer@example.com',
          password: 'Password123!',
        },
      });
      const tokenToRevoke = JSON.parse(loginRes.body).token;

      // 2. Verify token is initially valid
      const meBefore = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${tokenToRevoke}` },
      });
      expect(meBefore.statusCode).toBe(200);

      // 3. Call logout endpoint
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: `Bearer ${tokenToRevoke}` },
      });
      expect(logoutRes.statusCode).toBe(200);
      const logoutBody = JSON.parse(logoutRes.body);
      expect(logoutBody.success).toBe(true);

      // 4. Verify the revoked token is rejected on subsequent requests
      const meAfter = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${tokenToRevoke}` },
      });
      expect(meAfter.statusCode).toBe(401);
      const meAfterBody = JSON.parse(meAfter.body);
      expect(meAfterBody.error.code).toBe('TOKEN_REVOKED');
    });
  });
});
