import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import type { MockEmbeddingProvider } from '../src/services/ingestion/embeddingProvider.js';
import { createEmbeddingProvider } from '../src/services/ingestion/embeddingProvider.js';
import { uploadAndProcessDocument } from '../src/services/documentService.js';
import type { EmbeddingProvider } from '../src/services/ingestion/types.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

/**
 * Helper to construct multipart/form-data payloads with binary support.
 */
function createMultipartPayload(
  fields: Record<string, string>,
  file?: { fieldName: string; filename: string; contentType: string; content: Buffer | string }
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      )
    );
  }

  if (file) {
    const fileBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      )
    );
    chunks.push(fileBuf);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

describe('Phase 9: Document Versions, Re-indexing, Diffing, and Deletion', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_document_versions_phase9_32chars!';

  let orgAId: string;
  let orgBId: string;

  let adminAToken: string;
  let memberAToken: string;
  let memberAUserId: string;
  let viewerAToken: string;
  let adminBToken: string;

  let docId: string;
  let v1Id: string;
  let v2Id: string;
  let v3Id: string;

  beforeAll(async () => {
    // Reset test database safely before overriding process.env.DATABASE_URL
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;
    process.env.LLM_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'mock_groq_api_key_test';

    const testEnv = validateEnv({
      PORT: '4005',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
      MAX_FILE_SIZE_BYTES: '10485760',
      LLM_PROVIDER: 'groq',
      GROQ_API_KEY: 'mock_groq_api_key_test',
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

    const adminA = await register('admin_a_v9@example.com');
    adminAToken = adminA.token;

    const memberA = await register('member_a_v9@example.com');
    memberAToken = memberA.token;
    memberAUserId = memberA.userId;

    const viewerA = await register('viewer_a_v9@example.com');
    viewerAToken = viewerA.token;

    const adminB = await register('admin_b_v9@example.com');
    adminBToken = adminB.token;

    // Create Organization A
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'Acme Cloud A', slug: 'acme-cloud-a' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add Member and Viewer to Organization A
    await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
      [orgAId, memberA.userId, viewerA.userId]
    );

    // Create Organization B
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminBToken}` },
      payload: { name: 'Beta Corp B', slug: 'beta-corp-b' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closePool();
  });

  describe('1. Version Creation, Sequencing & Ingestion', () => {
    it('creates initial version 1 when document is uploaded', async () => {
      const v1Content = [
        '# Messaging Architecture Specification',
        'System uses Apache Kafka for streaming ingestion.',
        'High throughput partitions are configured with 3x replication.',
      ].join('\n');

      const multipart = createMultipartPayload(
        { organizationId: orgAId, name: 'Messaging Specs' },
        { fieldName: 'file', filename: 'messaging_specs.md', contentType: 'text/markdown', content: v1Content }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.document).toBeDefined();
      expect(body.document.name).toBe('Messaging Specs');
      expect(body.document.status).toBe('ready');
      expect(body.document.currentVersion).toBeDefined();
      expect(body.document.currentVersion.versionNumber).toBe(1);
      expect(body.document.currentVersion.status).toBe('ready');

      docId = body.document.id;
      v1Id = body.document.currentVersionId;

      // Verify DB records
      const verRes = await query<{ version_number: number; status: string }>(
        'SELECT version_number, status FROM document_versions WHERE id = $1',
        [v1Id]
      );
      expect(verRes.rows[0]?.version_number).toBe(1);
      expect(verRes.rows[0]?.status).toBe('ready');
    });

    it('creates version 2 when changed content is uploaded via POST /:id/versions', async () => {
      const v2Content = [
        '# Messaging Architecture Specification',
        'System was migrated from Apache Kafka to RabbitMQ broker.',
        'AMQP exchanges route events with fanout queues and dead-letter topics.',
      ].join('\n');

      const multipart = createMultipartPayload(
        {},
        { fieldName: 'file', filename: 'messaging_specs_v2.md', contentType: 'text/markdown', content: v2Content }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.document.id).toBe(docId);
      expect(body.document.currentVersion.versionNumber).toBe(2);
      expect(body.document.currentVersion.status).toBe('ready');
      expect(body.document.currentVersionId).not.toBe(v1Id);

      v2Id = body.document.currentVersionId;

      // Check DB versions table count
      const allVerRes = await query<{ count: string }>(
        'SELECT count(id) FROM document_versions WHERE document_id = $1',
        [docId]
      );
      expect(allVerRes.rows[0]?.count).toBe('2');
    });

    it('creates version 3 when uploading changed content to POST /api/documents with documentId field', async () => {
      const v3Content = [
        '# Messaging Architecture Specification',
        'System now uses hybrid NATS JetStream and RabbitMQ.',
        'Low latency streaming is handled by NATS core clustered servers.',
      ].join('\n');

      const multipart = createMultipartPayload(
        { organizationId: orgAId, documentId: docId },
        { fieldName: 'file', filename: 'messaging_specs_v3.md', contentType: 'text/markdown', content: v3Content }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.document.id).toBe(docId);
      expect(body.document.currentVersion.versionNumber).toBe(3);
      expect(body.document.currentVersion.status).toBe('ready');

      v3Id = body.document.currentVersionId;
    });

    it('GET /api/documents/:id returns full version history ordered descending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.document.currentVersionId).toBe(v3Id);
      expect(body.document.versions).toBeDefined();
      expect(body.document.versions.length).toBe(3);
      expect(body.document.versions[0].versionNumber).toBe(3);
      expect(body.document.versions[1].versionNumber).toBe(2);
      expect(body.document.versions[2].versionNumber).toBe(1);
    });

    it('GET /api/documents/:id/versions returns version list with current flag', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}/versions`,
        headers: {
          authorization: `Bearer ${viewerAToken}`, // Viewer can read
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.documentId).toBe(docId);
      expect(body.currentVersionId).toBe(v3Id);
      expect(body.versions.length).toBe(3);

      const current = body.versions.find((v: { isCurrent: boolean }) => v.isCurrent);
      expect(current.id).toBe(v3Id);
      expect(current.versionNumber).toBe(3);
    });
  });

  describe('2. Deduplication Policy', () => {
    it('rejects uploading identical content to existing document with 409 DUPLICATE_VERSION', async () => {
      // Content identical to v3
      const v3Content = [
        '# Messaging Architecture Specification',
        'System now uses hybrid NATS JetStream and RabbitMQ.',
        'Low latency streaming is handled by NATS core clustered servers.',
      ].join('\n');

      const multipart = createMultipartPayload(
        {},
        { fieldName: 'file', filename: 'specs_identical.md', contentType: 'text/markdown', content: v3Content }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DUPLICATE_VERSION');
      expect(body.error.details.existingDocumentId).toBe(docId);
      expect(body.error.details.versionNumber).toBe(3);
    });

    it('rejects uploading identical content to existing document via POST /api/documents with documentId', async () => {
      const v2Content = [
        '# Messaging Architecture Specification',
        'System was migrated from Apache Kafka to RabbitMQ broker.',
        'AMQP exchanges route events with fanout queues and dead-letter topics.',
      ].join('\n');

      const multipart = createMultipartPayload(
        { organizationId: orgAId, documentId: docId },
        { fieldName: 'file', filename: 'specs_v2_dup.md', contentType: 'text/markdown', content: v2Content }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DUPLICATE_VERSION');
      expect(body.error.details.versionNumber).toBe(2);
    });
  });

  describe('3. Version Activation & Rollback', () => {
    it('allows Member to activate previous version 1', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${v1Id}/activate`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.currentVersionId).toBe(v1Id);
      expect(body.previousVersionId).toBe(v3Id);

      // Verify in document details
      const docRes = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      const docBody = JSON.parse(docRes.body);
      expect(docBody.document.currentVersionId).toBe(v1Id);
      expect(docBody.document.currentVersion.versionNumber).toBe(1);
    });

    it('rejects activating a non-existent version with 404', async () => {
      const fakeVersionId = '00000000-0000-0000-0000-000000000999';
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${fakeVersionId}/activate`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VERSION_NOT_FOUND');
    });

    it('rejects activating a failed version with 400 CANNOT_ACTIVATE_NON_READY_VERSION', async () => {
      // Create a temporary failed version
      const failedVerRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, error_message)
         VALUES ($1, 99, 'dummy_failed_hash', 'failed', 'Parser broke')
         RETURNING id`,
        [docId]
      );
      const failedVersionId = failedVerRes.rows[0]!.id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${failedVersionId}/activate`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('CANNOT_ACTIVATE_NON_READY_VERSION');

      // Cleanup dummy version
      await query('DELETE FROM document_versions WHERE id = $1', [failedVersionId]);
    });

    it('reactivates version 3 as current version', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${v3Id}/activate`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('4. Safe & Idempotent Re-indexing', () => {
    it('re-indexes active version idempotently without duplicating active chunks', async () => {
      // Check pre-reindex chunk count in PostgreSQL
      const preCountRes = await query<{ count: string }>(
        'SELECT count(id) FROM chunks WHERE document_version_id = $1',
        [v3Id]
      );
      const initialChunkCount = parseInt(preCountRes.rows[0]?.count ?? '0', 10);
      expect(initialChunkCount).toBeGreaterThan(0);

      // Execute POST /api/documents/:id/reindex
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/reindex`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
        payload: {
          versionId: v3Id,
        },
      });

      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      expect(body1.reindex.success).toBe(true);
      expect(body1.reindex.status).toBe('ready');

      // Verify exact same chunk count (no duplicate chunks created)
      const postCountRes1 = await query<{ count: string }>(
        'SELECT count(id) FROM chunks WHERE document_version_id = $1',
        [v3Id]
      );
      expect(parseInt(postCountRes1.rows[0]?.count ?? '0', 10)).toBe(initialChunkCount);

      // Re-index a second time (idempotency check)
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/reindex`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      expect(res2.statusCode).toBe(200);

      const postCountRes2 = await query<{ count: string }>(
        'SELECT count(id) FROM chunks WHERE document_version_id = $1',
        [v3Id]
      );
      expect(parseInt(postCountRes2.rows[0]?.count ?? '0', 10)).toBe(initialChunkCount);
    });

    it('re-indexes with custom chunk configuration', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/reindex`,
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          versionId: v3Id,
          config: {
            maxChunkSizeChars: 60, // Smaller chunks
            chunkOverlapChars: 10,
            minChunkSizeChars: 20,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.reindex.status).toBe('ready');
      expect(body.reindex.chunkCount).toBeGreaterThanOrEqual(2);
    });

    it('marks version as failed on ingestion failure and does not leave it ready', async () => {
      // Temporarily tamper rawText to empty string in source_details to trigger ingestion failure
      const versionDb = await query<{ source_details: Record<string, unknown> }>(
        'SELECT source_details FROM document_versions WHERE id = $1',
        [v2Id]
      );
      const originalDetails = versionDb.rows[0]!.source_details;

      try {
        await query(
          `UPDATE document_versions
           SET source_details = $1
           WHERE id = $2`,
          [JSON.stringify({ ...originalDetails, rawText: '' }), v2Id]
        );

        const res = await app.inject({
          method: 'POST',
          url: `/api/documents/${docId}/reindex`,
          headers: { authorization: `Bearer ${memberAToken}` },
          payload: {
            versionId: v2Id,
          },
        });

        expect(res.statusCode).toBe(400);

        // Check DB: version 2 is now marked failed
        const checkVer = await query<{ status: string; error_message: string }>(
          'SELECT status, error_message FROM document_versions WHERE id = $1',
          [v2Id]
        );
        expect(checkVer.rows[0]?.status).toBe('failed');
      } finally {
        // Restore rawText and reindex back to ready
        await query(
          `UPDATE document_versions
           SET source_details = $1
           WHERE id = $2`,
          [JSON.stringify(originalDetails), v2Id]
        );

        const restoreRes = await app.inject({
          method: 'POST',
          url: `/api/documents/${docId}/reindex`,
          headers: { authorization: `Bearer ${memberAToken}` },
          payload: { versionId: v2Id },
        });
        expect(restoreRes.statusCode).toBe(200);
      }
    });
  });

  describe('5. Search Isolation Across Versions', () => {
    it('only returns chunks from current active version in search', async () => {
      // Currently, v3 is active (contains "NATS JetStream")
      // v1 contains "Apache Kafka"
      // v2 contains "RabbitMQ broker"

      // 1. Search for "NATS" while v3 is active -> all chunks must belong to active version v3
      const searchRes1 = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/search`,
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          query: 'NATS JetStream clustered servers',
          mode: 'hybrid',
        },
      });
      expect(searchRes1.statusCode).toBe(200);
      const searchBody1 = JSON.parse(searchRes1.body);
      expect(searchBody1.chunks.length).toBeGreaterThan(0);
      expect(searchBody1.chunks.every((c: { documentVersionId: string }) => c.documentVersionId === v3Id)).toBe(true);
      expect(searchBody1.chunks.some((c: { documentVersionId: string }) => c.documentVersionId === v1Id)).toBe(false);

      // Keyword search for "Kafka" while v3 is active -> returns 0 chunks (v1 is not current!)
      const searchRes2 = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/search`,
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          query: 'Kafka',
          mode: 'keyword',
        },
      });
      expect(searchRes2.statusCode).toBe(200);
      const searchBody2 = JSON.parse(searchRes2.body);
      expect(searchBody2.chunks.length).toBe(0);

      // 3. Activate v1
      await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${v1Id}/activate`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      // 4. Now keyword search for "Kafka" -> returns v1 chunks!
      const searchRes3 = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/search`,
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          query: 'Kafka',
          mode: 'keyword',
        },
      });
      expect(searchRes3.statusCode).toBe(200);
      const searchBody3 = JSON.parse(searchRes3.body);
      expect(searchBody3.chunks.length).toBeGreaterThan(0);
      expect(searchBody3.chunks.every((c: { documentVersionId: string }) => c.documentVersionId === v1Id)).toBe(true);

      // And keyword search for "NATS" now returns 0 chunks because v3 is no longer current
      const searchRes4 = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/search`,
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          query: 'NATS',
          mode: 'keyword',
        },
      });
      expect(searchRes4.statusCode).toBe(200);
      const searchBody4 = JSON.parse(searchRes4.body);
      expect(searchBody4.chunks.length).toBe(0);

      // 5. Restore v3 as active
      await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${v3Id}/activate`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
    });
  });

  describe('6. Version Comparison and Diffing', () => {
    it('computes line-level diff between version 1 and version 2', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}/diff?fromVersion=1&toVersion=2`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.documentId).toBe(docId);
      expect(body.fromVersion.versionNumber).toBe(1);
      expect(body.toVersion.versionNumber).toBe(2);
      expect(body.isContentIdentical).toBe(false);
      expect(body.linesAdded).toBeGreaterThan(0);
      expect(body.linesRemoved).toBeGreaterThan(0);
      expect(body.unifiedDiff).toContain('--- v1');
      expect(body.unifiedDiff).toContain('+++ v2');
      expect(body.chunks).toBeDefined();
      expect(body.chunks.some((c: { type: string }) => c.type === 'added')).toBe(true);
      expect(body.chunks.some((c: { type: string }) => c.type === 'removed')).toBe(true);
    });

    it('reports identical content when diffing a version with itself', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}/diff?fromVersion=2&toVersion=2`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.isContentIdentical).toBe(true);
      expect(body.linesAdded).toBe(0);
      expect(body.linesRemoved).toBe(0);
      expect(body.characterCountDelta).toBe(0);
    });

    it('returns 404 when diffing with a non-existent version', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}/diff?fromVersion=1&toVersion=999`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('VERSION_NOT_FOUND');
    });
  });

  describe('7. RBAC & Tenant Isolation', () => {
    it('Viewer is FORBIDDEN from uploading new version (403)', async () => {
      const multipart = createMultipartPayload(
        {},
        { fieldName: 'file', filename: 'viewer_v.md', contentType: 'text/markdown', content: '# Viewer content' }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions`,
        headers: {
          authorization: `Bearer ${viewerAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Viewer is FORBIDDEN from re-indexing documents (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/reindex`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Viewer is FORBIDDEN from activating document versions (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/versions/${v1Id}/activate`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Member is FORBIDDEN from deleting documents (403)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${docId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Tenant B cannot access versions of Tenant A document (404)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}/versions`,
        headers: { authorization: `Bearer ${adminBToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('Tenant B cannot diff Tenant A document versions (404)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docId}/diff?fromVersion=1&toVersion=2`,
        headers: { authorization: `Bearer ${adminBToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('Tenant B cannot re-index Tenant A document (404)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docId}/reindex`,
        headers: { authorization: `Bearer ${adminBToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('8. Concurrent Version Creation & Row Locking (Regression F-01)', () => {
    let concurrencyDocId: string;

    it('creates base document for concurrency testing', async () => {
      const multipart = createMultipartPayload(
        { organizationId: orgAId, name: 'Concurrency Test Doc' },
        { fieldName: 'file', filename: 'concurrency_base.md', contentType: 'text/markdown', content: '# Concurrency Base\nInitial baseline content.' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      concurrencyDocId = JSON.parse(res.body).document.id;
    });

    it('simultaneously uploads 3 distinct versions to the same document and verifies distinct sequential version numbers', async () => {
      const upload = (suffix: string, content: string) => {
        const mp = createMultipartPayload(
          {},
          { fieldName: 'file', filename: `conc_${suffix}.md`, contentType: 'text/markdown', content }
        );
        return app.inject({
          method: 'POST',
          url: `/api/documents/${concurrencyDocId}/versions`,
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });
      };

      // Launch 3 simultaneous requests against the same document
      const [resA, resB, resC] = await Promise.all([
        upload('A', '# Version Delta A\nUnique content payload for delta A.'),
        upload('B', '# Version Delta B\nUnique content payload for delta B.'),
        upload('C', '# Version Delta C\nUnique content payload for delta C.'),
      ]);

      expect(resA.statusCode).toBe(201);
      expect(resB.statusCode).toBe(201);
      expect(resC.statusCode).toBe(201);

      const verNumbers = [
        JSON.parse(resA.body).document.currentVersion.versionNumber,
        JSON.parse(resB.body).document.currentVersion.versionNumber,
        JSON.parse(resC.body).document.currentVersion.versionNumber,
      ].sort((a, b) => a - b);

      // Distinct sequential version numbers 2, 3, 4 without collision or duplicate error
      expect(verNumbers).toEqual([2, 3, 4]);

      // Check PostgreSQL document_versions records
      const allVers = await query<{ id: string; version_number: number; status: string }>(
        'SELECT id, version_number, status FROM document_versions WHERE document_id = $1 ORDER BY version_number ASC',
        [concurrencyDocId]
      );
      expect(allVers.rows.map((r) => r.version_number)).toEqual([1, 2, 3, 4]);
      expect(allVers.rows.every((r) => r.status === 'ready')).toBe(true);

      // Verify parent current_version_id points to a valid ready version
      const docDb = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [concurrencyDocId]
      );
      const activeVersionId = docDb.rows[0]?.current_version_id;
      const activeVersion = allVers.rows.find((r) => r.id === activeVersionId);
      expect(activeVersion).toBeDefined();
      expect(activeVersion?.status).toBe('ready');
      // With monotonic conditional activation, the maximum sequential version number (4) is guaranteed to be current
      expect(activeVersion?.version_number).toBe(4);
    });

    it('simultaneous upload of identical content correctly returns 409 DUPLICATE_VERSION for the second request', async () => {
      const identicalContent = '# Concurrent Duplicate\nExact identical payload for duplicate collision test.';

      const uploadDup = () => {
        const mp = createMultipartPayload(
          {},
          { fieldName: 'file', filename: 'duplicate_conc.md', contentType: 'text/markdown', content: identicalContent }
        );
        return app.inject({
          method: 'POST',
          url: `/api/documents/${concurrencyDocId}/versions`,
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });
      };

      const [res1, res2] = await Promise.all([uploadDup(), uploadDup()]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
      expect(statusCodes).toEqual([201, 409]);

      const dupRes = res1.statusCode === 409 ? res1 : res2;
      const dupBody = JSON.parse(dupRes.body);
      expect(dupBody.error.code).toBe('DUPLICATE_VERSION');
      expect(dupBody.error.details.existingDocumentId).toBe(concurrencyDocId);
    });
  });

  describe('9. Document Deletion & Historical Provenance (Tombstone)', () => {
    it('deletes document and preserves historical citations with sourceDeleted tombstone', async () => {
      // 1. Create a chat session in Org A
      const sessionRes = await app.inject({
        method: 'POST',
        url: '/api/chat/sessions',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'x-organization-id': orgAId,
        },
        payload: {
          organizationId: orgAId,
          title: 'Architecture Review Session',
        },
      });
      expect(sessionRes.statusCode).toBe(201);
      const sessionData = JSON.parse(sessionRes.body);
      const sessionId = sessionData.session?.id || sessionData.id;

      // 2. Send message in session grounded on docId
      // Directly insert citation record into citations table to test tombstone preservation
      const msgRes = await query<{ id: string }>(
        `INSERT INTO messages (session_id, role, content)
         VALUES ($1, 'assistant', 'The system utilizes NATS JetStream [1].')
         RETURNING id`,
        [sessionId]
      );
      const messageId = msgRes.rows[0]!.id;

      // Find an active chunk of docId
      const chunkRes = await query<{ id: string }>(
        'SELECT id FROM chunks WHERE document_version_id = $1 LIMIT 1',
        [v3Id]
      );
      const targetChunkId = chunkRes.rows[0]!.id;

      await query(
        `INSERT INTO citations (
           message_id, chunk_id, citation_number, document_id, document_name,
           page_number, section_title, snippet
         ) VALUES ($1, $2, 1, $3, 'Messaging Specs', 1, 'Architecture', 'NATS JetStream servers')`,
        [messageId, targetChunkId, docId]
      );

      // Verify citation is initially present with chunkId and documentId
      const listBeforeRes = await app.inject({
        method: 'GET',
        url: `/api/chat/sessions/${sessionId}/messages`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      const listBeforeBody = JSON.parse(listBeforeRes.body);
      expect(listBeforeBody.messages[0].citations.length).toBe(1);
      expect(listBeforeBody.messages[0].citations[0].chunkId).toBe(targetChunkId);
      expect(listBeforeBody.messages[0].citations[0].documentId).toBe(docId);
      expect(listBeforeBody.messages[0].citations[0].sourceDeleted).toBeUndefined();

      // 3. Admin deletes the document
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${docId}`,
        headers: { authorization: `Bearer ${adminAToken}` },
      });
      expect(delRes.statusCode).toBe(200);

      // 4. Verify document, versions, and chunks are deleted from DB
      const docCheck = await query('SELECT id FROM documents WHERE id = $1', [docId]);
      expect(docCheck.rows.length).toBe(0);

      const verCheck = await query('SELECT id FROM document_versions WHERE document_id = $1', [docId]);
      expect(verCheck.rows.length).toBe(0);

      const chunkCheck = await query('SELECT id FROM chunks WHERE id = $1', [targetChunkId]);
      expect(chunkCheck.rows.length).toBe(0);

      // 5. Verify historical chat messages STILL preserve the citation with sourceDeleted: true
      const listAfterRes = await app.inject({
        method: 'GET',
        url: `/api/chat/sessions/${sessionId}/messages`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      const listAfterBody = JSON.parse(listAfterRes.body);
      expect(listAfterBody.messages[0].citations.length).toBe(1);

      const citation = listAfterBody.messages[0].citations[0];
      expect(citation.documentName).toBe('Messaging Specs');
      expect(citation.citationNumber).toBe(1);
      expect(citation.snippet).toBe('NATS JetStream servers');
      expect(citation.sourceDeleted).toBe(true);
      expect(citation.chunkId).toBeUndefined();
      expect(citation.documentId).toBeUndefined();

      // 6. Inspecting the deleted chunk source returns 404
      const chunkInspectRes = await app.inject({
        method: 'GET',
        url: `/api/chat/sources/${targetChunkId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      expect(chunkInspectRes.statusCode).toBe(404);
    });
  });

  describe('10. Current Version Pointer Semantics Under Concurrency (Regression F-04)', () => {
    let f04DocId: string;
    let v1Id: string;
    let v2Id: string;
    let v3Id: string;
    let v4Id: string;
    let v5Id: string;

    class ControlledMockEmbeddingProvider implements EmbeddingProvider {
      readonly model = 'text-embedding-3-small';
      readonly dimensions = 1536;
      private barrierPromise: Promise<void> | null = null;
      private fallbackProvider: EmbeddingProvider;

      constructor() {
        this.fallbackProvider = createEmbeddingProvider(
          validateEnv({
            PORT: '4005',
            HOST: '127.0.0.1',
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            CORS_ORIGIN: 'http://localhost:5173',
            DATABASE_URL: TEST_DATABASE_URL,
            JWT_SECRET: testSecret,
            MAX_FILE_SIZE_BYTES: '10485760',
            LLM_PROVIDER: 'groq',
            GROQ_API_KEY: 'mock_groq_api_key_test',
          })
        );
      }

      setBarrier(p: Promise<void>) {
        this.barrierPromise = p;
      }

      async embedChunks(texts: string[]): Promise<number[][]> {
        if (this.barrierPromise) {
          await this.barrierPromise;
        }
        return this.fallbackProvider.embedChunks(texts);
      }
    }

    class FailingMockEmbeddingProvider implements EmbeddingProvider {
      readonly model = 'text-embedding-3-small';
      readonly dimensions = 1536;

      async embedChunks(_texts: string[]): Promise<number[][]> {
        throw new Error('Simulated embedding failure for unready candidate version');
      }
    }

    it('creates base document with initial version 1', async () => {
      const multipart = createMultipartPayload(
        { organizationId: orgAId, name: 'F-04 Ingestion Ordering Doc' },
        { fieldName: 'file', filename: 'f04_base.md', contentType: 'text/markdown', content: '# Base Document\nInitial version 1 content.' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      f04DocId = data.document.id;
      v1Id = data.document.currentVersion.id;
      expect(data.document.currentVersion.versionNumber).toBe(1);
    });

    it('demonstrates out-of-order ingestion: slower older version (v2) finishes after newer version (v3) and does NOT overwrite v3', async () => {
      let resolveV2Barrier!: () => void;
      const v2Barrier = new Promise<void>((resolve) => {
        resolveV2Barrier = resolve;
      });

      const controlledProvider = new ControlledMockEmbeddingProvider();
      controlledProvider.setBarrier(v2Barrier);

      // 1. Launch upload of Version 2 with the controlled provider (will pause at embedding stage)
      const v2UploadPromise = uploadAndProcessDocument({
        organizationId: orgAId,
        userId: memberAUserId,
        documentId: f04DocId,
        filename: 'f04_v2.md',
        buffer: Buffer.from('# Version 2\nSlower older version content that takes longer to ingest.'),
        provider: controlledProvider,
      });

      // 2. Poll PostgreSQL until Version 2 has been allocated version_number = 2 under the F-01 row lock
      let v2Row: { id: string; version_number: number; status: string } | null = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        const checkRes = await query<{ id: string; version_number: number; status: string }>(
          'SELECT id, version_number, status FROM document_versions WHERE document_id = $1 AND version_number = 2',
          [f04DocId]
        );
        if (checkRes.rows.length > 0) {
          v2Row = checkRes.rows[0]!;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(v2Row).toBeDefined();
      expect(v2Row?.version_number).toBe(2);
      v2Id = v2Row!.id;

      // 3. While Version 2 is paused at embedding, upload Version 3 normally (which completes quickly)
      const mpV3 = createMultipartPayload(
        {},
        { fieldName: 'file', filename: 'f04_v3.md', contentType: 'text/markdown', content: '# Version 3\nNewer version content that completes fast.' }
      );
      const resV3 = await app.inject({
        method: 'POST',
        url: `/api/documents/${f04DocId}/versions`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mpV3.headers,
        },
        payload: mpV3.body,
      });

      expect(resV3.statusCode).toBe(201);
      const dataV3 = JSON.parse(resV3.body);
      v3Id = dataV3.document.currentVersion.id;
      expect(dataV3.document.currentVersion.versionNumber).toBe(3);

      // Confirm in PostgreSQL that documents.current_version_id is currently Version 3
      const docCheck1 = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [f04DocId]
      );
      expect(docCheck1.rows[0]?.current_version_id).toBe(v3Id);

      // 4. Unblock Version 2 barrier so it completes embedding and reaches line 359
      resolveV2Barrier();
      const v2Result = await v2UploadPromise;

      // Assert that Version 2 completed successfully and is marked 'ready'
      const v2InResult = v2Result.versions.find((v) => v.id === v2Id);
      expect(v2InResult?.status).toBe('ready');

      // CRITICAL REGRESSION ASSERTION (F-04): The slower older Version 2 MUST NOT have overwritten Version 3 as current
      const docCheck2 = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [f04DocId]
      );
      expect(docCheck2.rows[0]?.current_version_id).toBe(v3Id);

      // The returned result from the v2 upload also accurately reports that v3 remains current
      expect(v2Result.currentVersionId).toBe(v3Id);
      expect(v2Result.currentVersion?.versionNumber).toBe(3);
    });

    it('allows a newer candidate (v4) to become current when appropriate', async () => {
      const mpV4 = createMultipartPayload(
        {},
        { fieldName: 'file', filename: 'f04_v4.md', contentType: 'text/markdown', content: '# Version 4\nNewer version 4 content.' }
      );
      const resV4 = await app.inject({
        method: 'POST',
        url: `/api/documents/${f04DocId}/versions`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mpV4.headers,
        },
        payload: mpV4.body,
      });

      expect(resV4.statusCode).toBe(201);
      const dataV4 = JSON.parse(resV4.body);
      v4Id = dataV4.document.currentVersion.id;
      expect(dataV4.document.currentVersion.versionNumber).toBe(4);

      const docCheck = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [f04DocId]
      );
      expect(docCheck.rows[0]?.current_version_id).toBe(v4Id);
    });

    it('rejects failed or unready candidate from becoming current', async () => {
      const failingProvider = new FailingMockEmbeddingProvider();

      const uploadResult = await uploadAndProcessDocument({
        organizationId: orgAId,
        userId: memberAUserId,
        documentId: f04DocId,
        filename: 'f04_v5.md',
        buffer: Buffer.from('# Version 5\nFailing candidate content.'),
        provider: failingProvider,
      });

      // Check PostgreSQL: version 5 exists in 'failed' status
      const v5Res = await query<{ id: string; status: string; version_number: number }>(
        'SELECT id, status, version_number FROM document_versions WHERE document_id = $1 AND version_number = 5',
        [f04DocId]
      );
      expect(v5Res.rows.length).toBe(1);
      expect(v5Res.rows[0]?.status).toBe('failed');
      v5Id = v5Res.rows[0]!.id;

      // In the response, version 5 is marked failed and not current
      const v5Summary = uploadResult.versions.find((v) => v.id === v5Id);
      expect(v5Summary?.status).toBe('failed');
      expect(v5Summary?.isCurrent).toBe(false);

      // Document current_version_id must remain Version 4
      const docCheck = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [f04DocId]
      );
      expect(docCheck.rows[0]?.current_version_id).toBe(v4Id);
      expect(uploadResult.currentVersionId).toBe(v4Id);
    });

    it('allows explicit manual activation of an older ready version (v2) to succeed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${f04DocId}/versions/${v2Id}/activate`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.currentVersionId).toBe(v2Id);
      expect(body.previousVersionId).toBe(v4Id);

      // Verify in DB that current_version_id is now v2 (rollback honored)
      const docCheck = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [f04DocId]
      );
      expect(docCheck.rows[0]?.current_version_id).toBe(v2Id);
    });

    it('rejects explicit manual activation of a failed version (v5) with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${f04DocId}/versions/${v5Id}/activate`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('CANNOT_ACTIVATE_NON_READY_VERSION');

      // current_version_id is unchanged (still v2)
      const docCheck = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [f04DocId]
      );
      expect(docCheck.rows[0]?.current_version_id).toBe(v2Id);
    });
  });
});
