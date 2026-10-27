import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getPool, closePool } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

describe('Organizations, RBAC Permissions, and Tenant Isolation', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_rbac_suite_32_characters!';

  // Tokens for different users with different roles
  let adminToken: string;
  let adminUserId: string;

  let memberToken: string;
  let memberUserId: string;

  let viewerToken: string;
  let viewerUserId: string;

  let outsiderToken: string;
  let outsiderUserId: string;

  let orgId: string;
  let foreignOrgId: string;

  beforeAll(async () => {
    // Fresh test schema on dedicated test database
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;

    const testEnv = validateEnv({
      PORT: '4003',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
    });

    app = await buildApp({ env: testEnv });
    await app.ready();

    // Helper to register users
    async function register(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'SecurePassword123!' },
      });
      const body = JSON.parse(res.body);
      return { token: body.token as string, userId: body.user.id as string };
    }

    const admin = await register('admin@corp.com');
    adminToken = admin.token;
    adminUserId = admin.userId;

    const member = await register('member@corp.com');
    memberToken = member.token;
    memberUserId = member.userId;

    const viewer = await register('viewer@corp.com');
    viewerToken = viewer.token;
    viewerUserId = viewer.userId;

    const outsider = await register('outsider@othercorp.com');
    outsiderToken = outsider.token;
    outsiderUserId = outsider.userId;
  }, 30000);

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. Organization Creation & Initial Admin Role', () => {
    it('creates an organization and automatically grants the creator Admin role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Acme Engineering',
          slug: 'acme-eng',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.organization).toBeDefined();
      expect(body.organization.name).toBe('Acme Engineering');
      expect(body.organization.slug).toBe('acme-eng');
      expect(body.organization.role).toBe('admin');

      orgId = body.organization.id;
    });

    it('creates a second organization for the outsider user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: { authorization: `Bearer ${outsiderToken}` },
        payload: {
          name: 'Outsider Corp',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      foreignOrgId = body.organization.id;
    });

    it('lists only organizations the calling user belongs to', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/organizations',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.organizations.length).toBe(1);
      expect(body.organizations[0].id).toBe(orgId);

      // Outsider user sees only their foreign organization
      const outsiderRes = await app.inject({
        method: 'GET',
        url: '/api/organizations',
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      const outsiderBody = JSON.parse(outsiderRes.body);
      expect(outsiderBody.organizations.length).toBe(1);
      expect(outsiderBody.organizations[0].id).toBe(foreignOrgId);
    });
  });

  describe('2. Member Management & Role Assignment', () => {
    it('Admin adds a Member to the organization', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'member@corp.com',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.member.role).toBe('member');
      expect(body.member.email).toBe('member@corp.com');
    });

    it('Admin adds a Viewer to the organization', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'viewer@corp.com',
          role: 'viewer',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.member.role).toBe('viewer');
      expect(body.member.email).toBe('viewer@corp.com');
    });

    it('rejects adding an existing member with 409 Conflict', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'member@corp.com',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('MEMBER_ALREADY_EXISTS');
    });

    it('rejects adding an unregistered user email with 404 Not Found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          email: 'notregistered@example.com',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('USER_NOT_FOUND');
    });

    it('Member is FORBIDDEN from adding new members', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          email: 'outsider@othercorp.com',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Viewer is FORBIDDEN from adding new members', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          email: 'outsider@othercorp.com',
          role: 'member',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Admin can list all organization members', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.members.length).toBe(3); // admin, member, viewer
    });

    it('Viewer can view member list (read-only)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${orgId}/members`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.members.length).toBe(3);
    });

    it('Admin can update a member role', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${orgId}/members/${viewerUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'member' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.member.role).toBe('member');

      // Change back to viewer
      await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${orgId}/members/${viewerUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'viewer' },
      });
    });

    it('Admin CANNOT demote the sole administrator of the organization', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/organizations/${orgId}/members/${adminUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: 'member' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('CANNOT_DEMOTE_LAST_ADMIN');
    });

    it('Admin CANNOT remove the sole administrator of the organization', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}/members/${adminUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('CANNOT_REMOVE_LAST_ADMIN');
    });
  });

  describe('3. Role Matrix on Organization Resources (Admin vs Member vs Viewer)', () => {
    let createdDocId: string;

    it('Admin CAN upload/create a document', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/documents`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'architecture.md',
          sourceType: 'markdown',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.document).toBeDefined();
      expect(body.document.name).toBe('architecture.md');
      createdDocId = body.document.id;
    });

    it('Member CAN upload/create a document', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/documents`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          name: 'api_specs.pdf',
          sourceType: 'pdf',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.document.name).toBe('api_specs.pdf');
    });

    it('Viewer is FORBIDDEN from uploading documents (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/documents`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          name: 'viewer_attempt.txt',
          sourceType: 'text',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Viewer CAN read documents in the organization', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${orgId}/documents`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.documents.length).toBe(2);
    });

    it('Viewer is FORBIDDEN from deleting documents (403)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}/documents/${createdDocId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Member is FORBIDDEN from deleting documents (403)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}/documents/${createdDocId}`,
        headers: { authorization: `Bearer ${memberToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Admin CAN delete documents (200)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}/documents/${createdDocId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  describe('4. Cross-Tenant Isolation & Non-Disclosure', () => {
    it('rejects access to foreign organization details with 404 (non-disclosure)', async () => {
      // User from Acme Corp tries to view Outsider Corp's org details
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${foreignOrgId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // Returns 404 without leaking whether the organization ID exists
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('rejects access to foreign organization members with 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${foreignOrgId}/members`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('rejects uploading documents to a foreign organization with 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${foreignOrgId}/documents`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'infiltrate.md',
          sourceType: 'markdown',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('rejects listing documents of a foreign organization with 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${foreignOrgId}/documents`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('client-supplied organization ID header cannot bypass database membership verification', async () => {
      // Admin tries to spoof header to access foreign org
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${foreignOrgId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          'x-organization-id': foreignOrgId,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });
  });
});
