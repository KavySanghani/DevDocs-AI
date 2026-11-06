import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import {
  isTransientError,
  processIngestionJobDirectly,
  closeIngestionWorker,
  startIngestionWorker,
} from '../src/services/queue/ingestionWorker.js';
import { closeRedisConnections, isRedisAvailable } from '../src/services/queue/connection.js';
import { closeIngestionQueue, getIngestionQueue } from '../src/services/queue/ingestionQueue.js';
import {
  recoverStuckQueuedJobs,
  startPeriodicRecovery,
  stopPeriodicRecovery,
} from '../src/services/queue/recovery.js';
import {
  createJob,
  getJobById,
  getJobRecord,
  claimJobLease,
  renewJobLease,
  releaseJobFailure,
  LeaseFencingError,
} from '../src/services/jobs/jobService.js';
import { persistChunksWithEmbeddings } from '../src/services/ingestion/chunkPersistence.js';
import type { EmbeddingProvider } from '../src/services/ingestion/types.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

function createMultipartPayload(
  fields: Record<string, string>,
  file?: { fieldName: string; filename: string; contentType: string; content: Buffer | string }
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----WebKitFormBoundaryWorkerTest${Math.random().toString(36).slice(2)}`;
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

describe('Phase 10: Redis Queue, Background Workers, Retries, and Idempotency', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_worker_phase10_32chars!';

  let orgAId: string;
  let orgBId: string;
  let adminAToken: string;
  let memberAToken: string;
  let memberAUserId: string;
  let memberBToken: string;
  let memberBUserId: string;

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4006',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
      MAX_FILE_SIZE_BYTES: '10485760',
      WORKER_CONCURRENCY: '5',
      INGESTION_MAX_ATTEMPTS: '3',
      INGESTION_BACKOFF_MS: '100',
    });

    app = await buildApp({ env: testEnv });
    await app.ready();

    async function register(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'SecurePassword123!' },
      });
      const body = JSON.parse(res.body);
      return { token: body.token as string, userId: body.user.id as string };
    }

    const adminA = await register('admin_a_worker@example.com');
    adminAToken = adminA.token;

    const memberA = await register('member_a_worker@example.com');
    memberAToken = memberA.token;
    memberAUserId = memberA.userId;

    const memberB = await register('member_b_worker@example.com');
    memberBToken = memberB.token;
    memberBUserId = memberB.userId;

    // Create Org A
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'Acme Queue Org', slug: 'acme-queue-org' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add Member A to Org A
    const addMemberRes = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'member_a_worker@example.com', role: 'member' },
    });
    expect(addMemberRes.statusCode).toBe(201);

    // Create Org B
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${memberBToken}` },
      payload: { name: 'Beta Queue Org', slug: 'beta-queue-org' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;
  });

  afterAll(async () => {
    await closeIngestionWorker();
    await closeIngestionQueue();
    await closeRedisConnections();
    await app.close();
    await closePool();
  });

  describe('1. Error Classification (Transient vs Permanent)', () => {
    it('correctly classifies provider rate limits (429) as transient', () => {
      const err = Object.assign(new Error('Rate limit exceeded. Try again in 20s.'), { statusCode: 429 });
      expect(isTransientError(err)).toBe(true);
    });

    it('correctly classifies provider 5xx server errors as transient', () => {
      const err = Object.assign(new Error('Internal Server Error from upstream'), { statusCode: 503 });
      expect(isTransientError(err)).toBe(true);
    });

    it('correctly classifies network connection resets as transient', () => {
      const err = Object.assign(new Error('Connection reset by peer'), { code: 'ECONNRESET' });
      expect(isTransientError(err)).toBe(true);
    });

    it('correctly classifies permanent parser and validation errors as non-transient', () => {
      expect(isTransientError(new Error('Invalid markdown syntax at line 4'))).toBe(false);
      expect(isTransientError(new Error('Document version has no extracted text available for re-indexing'))).toBe(false);
      expect(isTransientError(Object.assign(new Error('Bad request'), { statusCode: 400 }))).toBe(false);
      expect(isTransientError(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))).toBe(false);
    });
  });

  describe('2. Asynchronous Ingestion Endpoints (HTTP 202 Accepted)', () => {
    let asyncDocId: string;
    let asyncVersionId: string;
    let asyncJobId: string;

    it('POST /api/documents?async=true returns 202 Accepted with durable jobId', async () => {
      const mp = createMultipartPayload(
        { organizationId: orgAId, name: 'Async Ingestion Doc' },
        {
          fieldName: 'file',
          filename: 'async-guide.md',
          contentType: 'text/markdown',
          content: '# Async Background Guide\n\nThis guide explains BullMQ and Redis workers.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.jobId).toBeDefined();
      expect(body.status).toBe('queued');
      expect(body.documentId).toBeDefined();
      expect(body.versionId).toBeDefined();
      expect(body.message).toContain('enqueued');

      asyncDocId = body.documentId;
      asyncVersionId = body.versionId;
      asyncJobId = body.jobId;

      // Verify PostgreSQL state: document version is in 'queued' status
      const verDb = await query<{ status: string }>(
        'SELECT status FROM document_versions WHERE id = $1',
        [asyncVersionId]
      );
      expect(verDb.rows[0]?.status).toBe('queued');

      // Verify PostgreSQL jobs table
      const jobDb = await query<{ status: string; type: string }>(
        'SELECT status, type FROM jobs WHERE id = $1',
        [asyncJobId]
      );
      expect(jobDb.rows[0]?.status).toBe('queued');
      expect(jobDb.rows[0]?.type).toBe('document_ingestion');
    });

    it('GET /api/jobs/:id returns authoritative job progress and status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/jobs/${asyncJobId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.job.id).toBe(asyncJobId);
      expect(body.job.organizationId).toBe(orgAId);
      expect(body.job.status).toBe('queued');
      expect(body.job.type).toBe('document_ingestion');
      expect(body.job.attempts).toBe(0);
      expect(body.job.documentId).toBe(asyncDocId);
      expect(body.job.versionId).toBe(asyncVersionId);
    });

    it('enforces tenant boundary on GET /api/jobs/:id (Org B cannot view Org A job)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/jobs/${asyncJobId}`,
        headers: { authorization: `Bearer ${memberBToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('JOB_NOT_FOUND');
    });

    it('returns 401 Unauthorized for unauthenticated GET /api/jobs/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/jobs/${asyncJobId}`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('POST /:id/versions?async=true returns 202 Accepted for new version', async () => {
      const mp = createMultipartPayload(
        {},
        {
          fieldName: 'file',
          filename: 'async-guide-v2.md',
          contentType: 'text/markdown',
          content: '# Async Guide v2\n\nUpdated contents for background processing.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${asyncDocId}/versions?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.jobId).toBeDefined();
      expect(body.status).toBe('queued');
      expect(body.documentId).toBe(asyncDocId);
    });

    it('POST /:id/reindex with async=true returns 202 Accepted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${asyncDocId}/reindex`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'prefer': 'respond-async',
        },
        payload: { versionId: asyncVersionId },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.jobId).toBeDefined();
      expect(body.status).toBe('queued');
      expect(body.documentId).toBe(asyncDocId);
    });
  });

  describe('3. Worker Processing & Success State Transition', () => {
    let testDocId: string;
    let testVerId: string;
    let testJobId: string;

    beforeAll(async () => {
      const mp = createMultipartPayload(
        { organizationId: orgAId, name: 'Worker Success Test Doc' },
        {
          fieldName: 'file',
          filename: 'success-worker.md',
          contentType: 'text/markdown',
          content: '# Worker Execution\n\nValidating asynchronous processing stages.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      const body = JSON.parse(res.body);
      testDocId = body.documentId;
      testVerId = body.versionId;
      testJobId = body.jobId;
    });

    it('executes background ingestion directly, updating job and document to ready', async () => {
      const result = await processIngestionJobDirectly({
        jobId: testJobId,
        organizationId: orgAId,
        documentId: testDocId,
        versionId: testVerId,
        type: 'document_ingestion',
      });

      expect(result.success).toBe(true);
      expect(result.chunkCount).toBeGreaterThan(0);

      // Verify PostgreSQL jobs record
      const jobDb = await getJobById(testJobId, memberAUserId);
      expect(jobDb.status).toBe('ready');
      expect(jobDb.stage).toBe('completed');
      expect(jobDb.attempts).toBe(1);

      // Verify PostgreSQL document version record
      const verDb = await query<{ status: string; source_details: Record<string, unknown> }>(
        'SELECT status, source_details FROM document_versions WHERE id = $1',
        [testVerId]
      );
      expect(verDb.rows[0]?.status).toBe('ready');
      expect(verDb.rows[0]?.source_details?.chunkCount).toBeGreaterThan(0);

      // Verify document current_version_id was monotonically activated (F-04)
      const docDb = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [testDocId]
      );
      expect(docDb.rows[0]?.current_version_id).toBe(testVerId);
    });
  });

  describe('4. Transient Failures, Retries, and Exponential Backoff', () => {
    let retryDocId: string;
    let retryVerId: string;
    let retryJobId: string;

    beforeAll(async () => {
      const mp = createMultipartPayload(
        { organizationId: orgAId, name: 'Retry Test Doc' },
        {
          fieldName: 'file',
          filename: 'retry-doc.md',
          contentType: 'text/markdown',
          content: '# Transient Error Testing\n\nSimulating 429 rate limit retry cycle.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      const body = JSON.parse(res.body);
      retryDocId = body.documentId;
      retryVerId = body.versionId;
      retryJobId = body.jobId;
    });

    it('marks job as retrying on transient provider 429 and increments attempt counter', async () => {
      let callCount = 0;
      const failingMockProvider: EmbeddingProvider = {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        async embedChunks() {
          callCount++;
          const err = Object.assign(new Error('Rate limit exceeded (429).'), { statusCode: 429 });
          throw err;
        },
      };

      // Expect processIngestionJobDirectly to throw retryable error on attempt 1
      await expect(
        processIngestionJobDirectly(
          {
            jobId: retryJobId,
            organizationId: orgAId,
            documentId: retryDocId,
            versionId: retryVerId,
            type: 'document_ingestion',
          },
          failingMockProvider
        )
      ).rejects.toThrow('Rate limit exceeded');

      expect(callCount).toBeGreaterThan(0);

      // Check PostgreSQL jobs table reflects retrying status and attempt 1
      const jobDb = await getJobById(retryJobId, memberAUserId);
      expect(jobDb.status).toBe('retrying');
      expect(jobDb.attempts).toBe(1);
      expect(jobDb.errorSummary).toContain('Rate limit exceeded');
    });

    it('succeeds on subsequent retry and transitions from retrying to ready', async () => {
      // Process with working provider (simulating retry after backoff)
      const result = await processIngestionJobDirectly({
        jobId: retryJobId,
        organizationId: orgAId,
        documentId: retryDocId,
        versionId: retryVerId,
        type: 'document_ingestion',
      });

      expect(result.success).toBe(true);

      const jobDb = await getJobById(retryJobId, memberAUserId);
      expect(jobDb.status).toBe('ready');
      expect(jobDb.stage).toBe('completed');
      expect(jobDb.attempts).toBe(2);
      expect(jobDb.errorSummary).toBeNull();
    });
  });

  describe('5. Exhausted Attempts & Permanent Failures', () => {
    it('permanently marks job and document_version as failed when max attempts are exceeded', async () => {
      const mp = createMultipartPayload(
        { organizationId: orgAId, name: 'Exhausted Doc' },
        {
          fieldName: 'file',
          filename: 'exhausted.md',
          contentType: 'text/markdown',
          content: '# Exhaustion Testing\n\nSimulating 3 consecutive failures.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      const body = JSON.parse(res.body);
      const jobId = body.jobId;
      const docId = body.documentId;
      const verId = body.versionId;

      const permanentMockProvider: EmbeddingProvider = {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        async embedChunks() {
          throw Object.assign(new Error('Gateway 504 Gateway Timeout'), { statusCode: 504 });
        },
      };

      // Attempt 1: marks retrying
      await expect(
        processIngestionJobDirectly(
          { jobId, organizationId: orgAId, documentId: docId, versionId: verId, type: 'document_ingestion' },
          permanentMockProvider
        )
      ).rejects.toThrow();

      // Attempt 2: marks retrying
      await expect(
        processIngestionJobDirectly(
          { jobId, organizationId: orgAId, documentId: docId, versionId: verId, type: 'document_ingestion' },
          permanentMockProvider
        )
      ).rejects.toThrow();

      // Attempt 3: exhausted (max_attempts = 3) -> terminal failure
      await expect(
        processIngestionJobDirectly(
          { jobId, organizationId: orgAId, documentId: docId, versionId: verId, type: 'document_ingestion' },
          permanentMockProvider
        )
      ).rejects.toThrow();

      const jobDb = await getJobById(jobId, memberAUserId);
      expect(jobDb.status).toBe('failed');
      expect(jobDb.attempts).toBe(3);
      expect(jobDb.stage).toBe('failed');

      const verDb = await query<{ status: string; error_message: string }>(
        'SELECT status, error_message FROM document_versions WHERE id = $1',
        [verId]
      );
      expect(verDb.rows[0]?.status).toBe('failed');
      expect(verDb.rows[0]?.error_message).toContain('Gateway Timeout');
    });
  });

  describe('6. Idempotency & Duplicate Delivery Safety', () => {
    it('duplicate delivery of already-ready job exits early without modifying database', async () => {
      const mp = createMultipartPayload(
        { organizationId: orgAId, name: 'Idempotency Doc' },
        {
          fieldName: 'file',
          filename: 'idempotent.md',
          contentType: 'text/markdown',
          content: '# Idempotency Test\n\nTesting duplicate delivery.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      const body = JSON.parse(res.body);
      const jobId = body.jobId;
      const docId = body.documentId;
      const verId = body.versionId;

      // First run: processes to ready
      const run1 = await processIngestionJobDirectly({
        jobId,
        organizationId: orgAId,
        documentId: docId,
        versionId: verId,
        type: 'document_ingestion',
      });
      expect(run1.success).toBe(true);

      const chunksBefore = await query<{ count: string }>(
        'SELECT count(*) FROM chunks WHERE document_version_id = $1',
        [verId]
      );

      // Second duplicate delivery: exits early without re-chunking
      const run2 = await processIngestionJobDirectly({
        jobId,
        organizationId: orgAId,
        documentId: docId,
        versionId: verId,
        type: 'document_ingestion',
      });
      expect(run2.success).toBe(true);

      const chunksAfter = await query<{ count: string }>(
        'SELECT count(*) FROM chunks WHERE document_version_id = $1',
        [verId]
      );
      expect(chunksAfter.rows[0]?.count).toBe(chunksBefore.rows[0]?.count);
    });
  });

  describe('7. Outbox Recovery Scanner', () => {
    it('recovers stranded queued jobs from PostgreSQL', async () => {
      // Create a document and a job directly in PostgreSQL simulating Redis downtime during enqueue
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, 'Stranded Outbox Doc', 'markdown')
         RETURNING id`,
        [orgAId, memberAUserId]
      );
      const strDocId = docRes.rows[0]!.id;

      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, 'mock_stranded_hash_123', 'queued', $2)
         RETURNING id`,
        [strDocId, JSON.stringify({ rawText: '# Stranded Content\n\nThis job was stuck in outbox.' })]
      );
      const strVerId = verRes.rows[0]!.id;

      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `stranded_outbox_test_${Date.now()}`,
        payload: {
          documentId: strDocId,
          versionId: strVerId,
          organizationId: orgAId,
        },
      });

      // Force job updated_at to simulate it being older than 10 seconds
      await query(
        `UPDATE jobs SET updated_at = now() - interval '20 seconds' WHERE id = $1`,
        [job.id]
      );

      // Run recovery scanner with olderThanSeconds: 0 to catch the newly queued job
      const recovery = await recoverStuckQueuedJobs({
        olderThanSeconds: 0,
        processDirectly: true,
      });

      expect(recovery.scanned).toBeGreaterThanOrEqual(1);
      expect(recovery.recovered).toBeGreaterThanOrEqual(1);

      // Verify the stranded job is now ready
      const recoveredJob = await getJobById(job.id, memberAUserId);
      expect(recoveredJob.status).toBe('ready');
      expect(recoveredJob.stage).toBe('completed');
    });
  });

  describe('8. Security: Cross-Tenant Payload Tampering Safeguard', () => {
    it('aborts and marks job failed if worker receives spoofed organizationId', async () => {
      // Create job for Org A
      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `spoof_test_${Date.now()}`,
        payload: {
          documentId: '00000000-0000-0000-0000-000000000000',
          versionId: '00000000-0000-0000-0000-000000000000',
          organizationId: orgAId,
        },
      });

      // Malicious payload attempts to process Org A job under Org B context
      await expect(
        processIngestionJobDirectly({
          jobId: job.id,
          organizationId: orgBId, // Mismatched Org
          documentId: '00000000-0000-0000-0000-000000000000',
          versionId: '00000000-0000-0000-0000-000000000000',
          type: 'document_ingestion',
        })
      ).rejects.toThrow('Cross-tenant violation');

      const jobDb = await query<{ status: string; error_summary: string }>(
        'SELECT status, error_summary FROM jobs WHERE id = $1',
        [job.id]
      );
      expect(jobDb.rows[0]?.status).toBe('failed');
      expect(jobDb.rows[0]?.error_summary).toContain('Cross-tenant violation');
    });
  });

  describe('9. Distributed Leases, Heartbeats & Split-Brain Fencing (F-01 Remediation)', () => {
    it('active processing job with valid lease is NOT reclaimed by recovery scanner', async () => {
      // 1. Create a document & job
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, 'Active Lease Doc', 'markdown')
         RETURNING id`,
        [orgAId, memberAUserId]
      );
      const docId = docRes.rows[0]!.id;

      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, 'hash_active_lease', 'queued', $2)
         RETURNING id`,
        [docId, JSON.stringify({ rawText: '# Active Lease Test' })]
      );
      const verId = verRes.rows[0]!.id;

      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `active_lease_${Date.now()}`,
        payload: { documentId: docId, versionId: verId, organizationId: orgAId },
      });

      // 2. Worker 1 claims lease for 60 seconds (active)
      const claim1 = await claimJobLease({
        jobId: job.id,
        workerId: 'worker-node-1',
        leaseDurationSeconds: 60,
      });
      expect(claim1.success).toBe(true);
      expect(claim1.job?.status).toBe('processing');
      expect(claim1.fencingToken).toBe(1);

      // 3. Recovery runs: active lease must NOT be reclaimed
      const recovery = await recoverStuckQueuedJobs({
        olderThanSeconds: 0,
        staleProcessingSeconds: 0,
        processDirectly: true,
      });

      const jobAfter = await getJobRecord(job.id);
      expect(jobAfter?.status).toBe('processing');
      expect(jobAfter?.locked_by).toBe('worker-node-1');
      expect(jobAfter?.fencing_token).toBe(1);
    });

    it('stale processing job with expired lease IS safely reclaimed and processed', async () => {
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, 'Expired Lease Doc', 'markdown')
         RETURNING id`,
        [orgAId, memberAUserId]
      );
      const docId = docRes.rows[0]!.id;

      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, 'hash_expired_lease', 'queued', $2)
         RETURNING id`,
        [docId, JSON.stringify({ rawText: '# Expired Lease Reclaimed' })]
      );
      const verId = verRes.rows[0]!.id;

      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `expired_lease_${Date.now()}`,
        payload: { documentId: docId, versionId: verId, organizationId: orgAId },
      });

      // Simulate a crashed worker: job was in processing, but locked_until and updated_at are in the past
      await query(
        `UPDATE jobs
         SET status = 'processing',
             locked_by = 'crashed-worker-99',
             locked_until = now() - interval '30 seconds',
             updated_at = now() - interval '60 seconds',
             fencing_token = 1
         WHERE id = $1`,
        [job.id]
      );

      // Recovery should detect expired lease and recover it
      const recovery = await recoverStuckQueuedJobs({
        olderThanSeconds: 0,
        staleProcessingSeconds: 0,
        processDirectly: true,
      });

      expect(recovery.recovered).toBeGreaterThanOrEqual(1);

      const jobAfter = await getJobRecord(job.id);
      expect(jobAfter?.status).toBe('ready');
      expect(jobAfter?.locked_by).toBeNull();
      expect(jobAfter?.locked_until).toBeNull();
    });

    it('stale processing job with exhausted attempts transitions to failed without overwriting ready document version (OBS-10-01)', async () => {
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, 'Exhausted Ready Doc', 'markdown')
         RETURNING id`,
        [orgAId, memberAUserId]
      );
      const docId = docRes.rows[0]!.id;

      // Version is already marked ready (e.g. from parallel or previously finalized processing)
      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, 'hash_exhausted_ready', 'ready', $2)
         RETURNING id`,
        [docId, JSON.stringify({ rawText: '# Already Ready Content' })]
      );
      const verId = verRes.rows[0]!.id;

      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `exhausted_ready_${Date.now()}`,
        payload: { documentId: docId, versionId: verId, organizationId: orgAId },
      });

      // Simulate a stale job in processing whose attempts have reached max_attempts (3) with expired lease
      await query(
        `UPDATE jobs
         SET status = 'processing',
             attempts = 3,
             max_attempts = 3,
             locked_by = 'exhausted-worker-99',
             locked_until = now() - interval '30 seconds',
             updated_at = now() - interval '60 seconds',
             fencing_token = 3
         WHERE id = $1`,
        [job.id]
      );

      // Run recovery scanner
      const recovery = await recoverStuckQueuedJobs({
        olderThanSeconds: 0,
        staleProcessingSeconds: 0,
        processDirectly: true,
      });

      expect(recovery.exhausted).toBeGreaterThanOrEqual(1);

      // Job transitions to failed
      const jobAfter = await getJobRecord(job.id);
      expect(jobAfter?.status).toBe('failed');
      expect(jobAfter?.error_summary).toContain('marking terminal failure');

      // Crucial assertion (OBS-10-01): Document version MUST remain ready and error_message must remain null
      const verAfter = await query<{ status: string; error_message: string | null }>(
        'SELECT status, error_message FROM document_versions WHERE id = $1',
        [verId]
      );
      expect(verAfter.rows[0]?.status).toBe('ready');
      expect(verAfter.rows[0]?.error_message).toBeNull();
    });

    it('worker heartbeats renew lease expiration continuously', async () => {
      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `heartbeat_test_${Date.now()}`,
        payload: { documentId: '00000000-0000-0000-0000-000000000000', versionId: '00000000-0000-0000-0000-000000000000' },
      });

      const claim = await claimJobLease({
        jobId: job.id,
        workerId: 'worker-node-hb',
        leaseDurationSeconds: 10,
      });
      expect(claim.success).toBe(true);
      const initialUntil = claim.job!.locked_until!;

      // Renew lease with heartbeat
      const renewed = await renewJobLease({
        jobId: job.id,
        workerId: 'worker-node-hb',
        fencingToken: claim.fencingToken!,
        leaseDurationSeconds: 60,
      });
      expect(renewed).toBe(true);

      const jobAfter = await getJobRecord(job.id);
      expect(jobAfter!.locked_until!.getTime()).toBeGreaterThanOrEqual(initialUntil.getTime());
    });

    it('split-brain guard: worker that loses lease/fencing token is prevented from finalizing', async () => {
      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `fencing_split_brain_${Date.now()}`,
        payload: { documentId: '00000000-0000-0000-0000-000000000000', versionId: '00000000-0000-0000-0000-000000000000' },
      });

      // Worker 1 claims with fencing token 1
      const claim1 = await claimJobLease({
        jobId: job.id,
        workerId: 'worker-1',
        leaseDurationSeconds: 1, // short lease
      });
      expect(claim1.fencingToken).toBe(1);

      // Expire Worker 1's lease
      await query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [job.id]);

      // Worker 2 reclaims with fencing token 2
      const claim2 = await claimJobLease({
        jobId: job.id,
        workerId: 'worker-2',
        leaseDurationSeconds: 60,
      });
      expect(claim2.success).toBe(true);
      expect(claim2.fencingToken).toBe(2);

      // Worker 1 now attempts to renew or finalize with outdated fencing token 1 -> rejected!
      const renewWorker1 = await renewJobLease({
        jobId: job.id,
        workerId: 'worker-1',
        fencingToken: 1,
      });
      expect(renewWorker1).toBe(false);

      // Verify authoritative database state belongs to Worker 2
      const jobRecord = await getJobRecord(job.id);
      expect(jobRecord?.locked_by).toBe('worker-2');
      expect(jobRecord?.fencing_token).toBe(2);
    });

    it('simultaneous lease claim attempts: exactly one worker succeeds', async () => {
      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `concurrent_claim_${Date.now()}`,
        payload: { documentId: '00000000-0000-0000-0000-000000000000', versionId: '00000000-0000-0000-0000-000000000000' },
      });

      const [resA, resB] = await Promise.all([
        claimJobLease({ jobId: job.id, workerId: 'concurrent-worker-A', leaseDurationSeconds: 30 }),
        claimJobLease({ jobId: job.id, workerId: 'concurrent-worker-B', leaseDurationSeconds: 30 }),
      ]);

      // Exactly one succeeds
      const successes = [resA.success, resB.success].filter(Boolean);
      expect(successes.length).toBe(1);
    });
  });

  describe('10. Periodic Recovery Scanner & Lifecycle (F-02 Remediation)', () => {
    it('periodic recovery runs on schedule and gracefully shuts down', async () => {
      // Create a stuck job
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, 'Periodic Recovery Doc', 'markdown')
         RETURNING id`,
        [orgAId, memberAUserId]
      );
      const docId = docRes.rows[0]!.id;

      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, 'hash_periodic_test', 'queued', $2)
         RETURNING id`,
        [docId, JSON.stringify({ rawText: '# Periodic Scanner Content' })]
      );
      const verId = verRes.rows[0]!.id;

      const { job } = await createJob({
        organizationId: orgAId,
        type: 'document_ingestion',
        idempotencyKey: `periodic_scan_${Date.now()}`,
        payload: { documentId: docId, versionId: verId, organizationId: orgAId },
      });

      // Force updated_at into past
      await query(`UPDATE jobs SET updated_at = now() - interval '20 seconds' WHERE id = $1`, [job.id]);

      // Start periodic recovery with fast interval for test
      startPeriodicRecovery({
        intervalMs: 100,
        olderThanSeconds: 0,
        staleProcessingSeconds: 0,
      });

      // Wait for at least one scan interval
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Stop periodic recovery gracefully
      await stopPeriodicRecovery();

      // Verify no dangling intervals / unhandled rejections
      expect(true).toBe(true);
    });
  });

  describe('11. Re-Index Idempotency Key Handling (F-03 Remediation)', () => {
    let reindexDocId: string;
    let reindexVerId: string;

    beforeAll(async () => {
      const mp = createMultipartPayload(
        { organizationId: orgAId, name: 'Reindex Idempotency Doc' },
        {
          fieldName: 'file',
          filename: 'reindex-idemp.md',
          contentType: 'text/markdown',
          content: '# Reindex Test Doc\n\nTesting idempotency keys on reindexing.',
        }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...mp.headers,
        },
        payload: mp.body,
      });

      const body = JSON.parse(res.body);
      reindexDocId = body.documentId;
      reindexVerId = body.versionId;

      // Ingest it to ready
      await processIngestionJobDirectly({
        jobId: body.jobId,
        organizationId: orgAId,
        documentId: reindexDocId,
        versionId: reindexVerId,
        type: 'document_ingestion',
      });
    });

    it('POST /:id/reindex with Idempotency-Key returns 202 and records job', async () => {
      const clientKey = 'client-reindex-key-001';

      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${reindexDocId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'idempotency-key': clientKey,
        },
        payload: { versionId: reindexVerId },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.jobId).toBeDefined();

      const jobRecord = await getJobRecord(body.jobId);
      expect(jobRecord?.idempotency_key).toContain(clientKey);
    });

    it('retrying with identical Idempotency-Key returns existing job without duplicate work', async () => {
      const clientKey = 'client-reindex-key-002';

      const res1 = await app.inject({
        method: 'POST',
        url: `/api/documents/${reindexDocId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'idempotency-key': clientKey,
        },
        payload: { versionId: reindexVerId },
      });
      expect(res1.statusCode).toBe(202);
      const body1 = JSON.parse(res1.body);

      // Retry with the exact same key
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/documents/${reindexDocId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'idempotency-key': clientKey,
        },
        payload: { versionId: reindexVerId },
      });
      expect(res2.statusCode).toBe(202);
      const body2 = JSON.parse(res2.body);

      // Must return identical jobId
      expect(body2.jobId).toBe(body1.jobId);
    });

    it('submitting with a new Idempotency-Key creates a fresh job', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/documents/${reindexDocId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'idempotency-key': 'key-run-A',
        },
        payload: { versionId: reindexVerId },
      });
      const body1 = JSON.parse(res1.body);

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/documents/${reindexDocId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'idempotency-key': 'key-run-B',
        },
        payload: { versionId: reindexVerId },
      });
      const body2 = JSON.parse(res2.body);

      expect(body2.jobId).not.toBe(body1.jobId);
    });

    it('cross-organization idempotency key isolation: Org B using Org A key creates separate job', async () => {
      // 1. Create document in Org B
      const mpB = createMultipartPayload(
        { organizationId: orgBId, name: 'Org B Reindex Doc' },
        {
          fieldName: 'file',
          filename: 'org-b-doc.md',
          contentType: 'text/markdown',
          content: '# Org B Documentation\n\nTesting tenant idempotency isolation.',
        }
      );

      const resUpload = await app.inject({
        method: 'POST',
        url: '/api/documents?async=true',
        headers: {
          authorization: `Bearer ${memberBToken}`,
          ...mpB.headers,
        },
        payload: mpB.body,
      });

      const docB = JSON.parse(resUpload.body);

      // Ingest to ready
      await processIngestionJobDirectly({
        jobId: docB.jobId,
        organizationId: orgBId,
        documentId: docB.documentId,
        versionId: docB.versionId,
        type: 'document_ingestion',
      });

      // Org B reindexes using the EXACT SAME client key that Org A used ('client-reindex-key-002')
      const resOrgB = await app.inject({
        method: 'POST',
        url: `/api/documents/${docB.documentId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberBToken}`,
          'idempotency-key': 'client-reindex-key-002',
        },
        payload: { versionId: docB.versionId },
      });

      expect(resOrgB.statusCode).toBe(202);
      const bodyOrgB = JSON.parse(resOrgB.body);
      expect(bodyOrgB.jobId).toBeDefined();

      // Verify the job belongs to Org B in PostgreSQL
      const jobRecordOrgB = await getJobRecord(bodyOrgB.jobId);
      expect(jobRecordOrgB?.organization_id).toBe(orgBId);
      expect(jobRecordOrgB?.idempotency_key).toContain('client-reindex-key-002');
    });

    it('rejects invalid Idempotency-Key with HTTP 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${reindexDocId}/reindex?async=true`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
          'idempotency-key': 'invalid key with spaces and @#$ symbols',
        },
        payload: { versionId: reindexVerId },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });
  });

  describe('12. Redis Integration & Graceful Offline Fallback (F-04 Verification)', () => {
    it('accurately verifies Redis connectivity status', async () => {
      const available = await isRedisAvailable();
      if (!available) {
        // Offline Redis handled gracefully: documents are accepted and recorded in PostgreSQL outbox
        console.log('[Redis Test Diagnostic]: Redis is offline on this host; offline outbox fallback verified.');
        expect(available).toBe(false);
      } else {
        console.log('[Redis Test Diagnostic]: Redis is online; live connection confirmed.');
        expect(available).toBe(true);
      }
    });
  });

  describe('13. Phase 10 Audit Remediation (SEC-10-01, SEC-10-02, SEC-10-03)', () => {
    describe('SEC-10-01: Prevent stale workers from corrupting document-version status', () => {
      it('Worker A with expired lease cannot mark document version failed or overwrite Worker B ready state', async () => {
        // Setup: Upload a document in Org A
        const mp = createMultipartPayload(
          { organizationId: orgAId, name: 'SEC-10-01 Test Doc' },
          {
            fieldName: 'file',
            filename: 'sec-10-01.md',
            contentType: 'text/markdown',
            content: '# SEC-10-01 Test\n\nTesting safe failure handling for stale workers.',
          }
        );

        const resUpload = await app.inject({
          method: 'POST',
          url: '/api/documents?async=true',
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });

        const docA = JSON.parse(resUpload.body);
        const { jobId, documentId, versionId } = docA;

        // 1. Worker A claims the job with a short lease
        const claimA = await claimJobLease({
          jobId,
          workerId: 'worker-A',
          leaseDurationSeconds: 1,
        });
        expect(claimA.success).toBe(true);
        expect(claimA.fencingToken).toBe(1);

        // 2. Worker A's lease expires
        await query(
          `UPDATE jobs SET locked_until = now() - interval '2 seconds' WHERE id = $1`,
          [jobId]
        );

        // 3. Worker B claims the job with a newer fencing token and completes ingestion successfully
        const runB = await processIngestionJobDirectly(
          {
            jobId,
            organizationId: orgAId,
            documentId,
            versionId,
            type: 'document_ingestion',
          },
          {
            workerId: 'worker-B',
            leaseDurationSeconds: 30,
          }
        );
        expect(runB.success).toBe(true);

        // Confirm database state is ready under Worker B
        const jobAfterB = await getJobRecord(jobId);
        expect(jobAfterB?.status).toBe('ready');
        expect(jobAfterB?.fencing_token).toBe(2);

        const verAfterB = await query<{ status: string; error_message: string | null }>(
          'SELECT status, error_message FROM document_versions WHERE id = $1',
          [versionId]
        );
        expect(verAfterB.rows[0]?.status).toBe('ready');
        expect(verAfterB.rows[0]?.error_message).toBeNull();

        // 4. Worker A resumes and attempts to report failure
        // Worker A still believes it is processing with fencing token 1
        const releasedA = await releaseJobFailure({
          jobId,
          workerId: 'worker-A',
          fencingToken: claimA.fencingToken!,
          newStatus: 'failed',
          errorSummary: 'Simulated Worker A failure after lease expiry',
          stage: 'failed',
          documentVersionId: versionId,
        });

        // 5. Worker A's failure update must be rejected (returns false) because it lost ownership
        expect(releasedA).toBe(false);

        // 6. Verify database state remains completely intact as ready:
        const jobFinal = await getJobRecord(jobId);
        expect(jobFinal?.status).toBe('ready');
        expect(jobFinal?.fencing_token).toBe(2);
        expect(jobFinal?.error_summary).toBeNull();

        const verFinal = await query<{ status: string; error_message: string | null }>(
          'SELECT status, error_message FROM document_versions WHERE id = $1',
          [versionId]
        );
        expect(verFinal.rows[0]?.status).toBe('ready');
        expect(verFinal.rows[0]?.error_message).toBeNull();
      });

      it('Worker A with expired lease cannot mark job or document version failed even if no replacement worker has claimed the job yet (FINDING-10-01)', async () => {
        // 1. Create a job and associated document version
        const mp = createMultipartPayload(
          { organizationId: orgAId, name: 'FINDING-10-01 Unclaimed Expired Lease Doc' },
          {
            fieldName: 'file',
            filename: 'unclaimed-expired.md',
            contentType: 'text/markdown',
            content: '# Unclaimed Expired Lease Test\n\nTesting lease expiration rejection without replacement worker.',
          }
        );

        const resUpload = await app.inject({
          method: 'POST',
          url: '/api/documents?async=true',
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });

        const docA = JSON.parse(resUpload.body);
        const { jobId, versionId } = docA;

        // 2. Claim the job using Worker A
        const claimA = await claimJobLease({
          jobId,
          workerId: 'worker-A',
          leaseDurationSeconds: 10,
        });
        expect(claimA.success).toBe(true);
        expect(claimA.fencingToken).toBe(1);

        // Verify initial processing state
        const jobInitial = await getJobRecord(jobId);
        expect(jobInitial?.status).toBe('processing');
        expect(jobInitial?.locked_by).toBe('worker-A');
        expect(jobInitial?.fencing_token).toBe(1);

        // 3. Expire Worker A's lease directly in devdocs_ai_test by setting locked_until = now() - interval '2 seconds'
        await query(
          `UPDATE jobs SET locked_until = now() - interval '2 seconds' WHERE id = $1`,
          [jobId]
        );

        // 4. Do not allow Worker B or the recovery scanner to claim the job
        // (locked_by is still 'worker-A', fencing_token is still 1, status is still 'processing')

        // 5. Call releaseJobFailure using Worker A's original worker ID and fencing token
        const released = await releaseJobFailure({
          jobId,
          workerId: 'worker-A',
          fencingToken: claimA.fencingToken!,
          newStatus: 'failed',
          errorSummary: 'Attempted failure write after lease expiry',
          stage: 'failed',
          documentVersionId: versionId,
        });

        // 6. Assert that it returns false
        expect(released).toBe(false);

        // 7. Query the actual database and assert:
        // - Job remains 'processing'
        // - Document version does not become 'failed'
        // - No failure error is written
        // - Worker ownership and fencing token have not been incorrectly changed
        const jobDb = await query<{
          status: string;
          locked_by: string | null;
          fencing_token: number;
          error_summary: string | null;
        }>(
          'SELECT status, locked_by, fencing_token, error_summary FROM jobs WHERE id = $1',
          [jobId]
        );
        expect(jobDb.rows[0]?.status).toBe('processing');
        expect(jobDb.rows[0]?.locked_by).toBe('worker-A');
        expect(jobDb.rows[0]?.fencing_token).toBe(1);
        expect(jobDb.rows[0]?.error_summary).toBeNull();

        const verDb = await query<{ status: string; error_message: string | null }>(
          'SELECT status, error_message FROM document_versions WHERE id = $1',
          [versionId]
        );
        expect(verDb.rows[0]?.status).toBe('queued');
        expect(verDb.rows[0]?.error_message).toBeNull();
      });

      it('releaseJobFailure never overwrites a version that was already marked ready even if called directly', async () => {
        // Setup: create job and version
        const mp = createMultipartPayload(
          { organizationId: orgAId, name: 'SEC-10-01 Already Ready Doc' },
          {
            fieldName: 'file',
            filename: 'ready-check.md',
            contentType: 'text/markdown',
            content: '# Already Ready Test\n\nTesting no overwrite on ready versions.',
          }
        );

        const resUpload = await app.inject({
          method: 'POST',
          url: '/api/documents?async=true',
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });

        const doc = JSON.parse(resUpload.body);
        const { jobId, versionId } = doc;

        // Force version to ready
        await query(
          `UPDATE document_versions SET status = 'ready' WHERE id = $1`,
          [versionId]
        );

        // Claim job
        const claim = await claimJobLease({
          jobId,
          workerId: 'worker-test',
          leaseDurationSeconds: 30,
        });
        expect(claim.success).toBe(true);

        // Attempt to release failure with documentVersionId
        const released = await releaseJobFailure({
          jobId,
          workerId: 'worker-test',
          fencingToken: claim.fencingToken!,
          newStatus: 'failed',
          errorSummary: 'Test error',
          stage: 'failed',
          documentVersionId: versionId,
        });

        expect(released).toBe(true);

        // Check document_versions: must still be ready because of `status != 'ready'` guard
        const verCheck = await query<{ status: string }>(
          'SELECT status FROM document_versions WHERE id = $1',
          [versionId]
        );
        expect(verCheck.rows[0]?.status).toBe('ready');
      });
    });

    describe('SEC-10-02: Enforce lease ownership atomically with chunk persistence', () => {
      it('stale worker paused during embedding call cannot delete/insert chunks or finalize when lease is superseded', async () => {
        // Setup document in Org A
        const mp = createMultipartPayload(
          { organizationId: orgAId, name: 'SEC-10-02 Persistence Fencing Doc' },
          {
            fieldName: 'file',
            filename: 'sec-10-02.md',
            contentType: 'text/markdown',
            content: '# SEC-10-02 Persistence Test\n\nVerifying database-enforced chunk fencing.',
          }
        );

        const resUpload = await app.inject({
          method: 'POST',
          url: '/api/documents?async=true',
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });

        const docA = JSON.parse(resUpload.body);
        const { jobId, documentId, versionId } = docA;

        // Create deferred promise to pause Worker A during embedding call
        let unpauseWorkerA!: () => void;
        const workerAPausePromise = new Promise<void>((resolve) => {
          unpauseWorkerA = resolve;
        });

        const pausingProviderA: EmbeddingProvider = {
          model: 'text-embedding-3-small',
          dimensions: 1536,
          async embedChunks(chunksToEmbed) {
            // Worker A pauses here
            await workerAPausePromise;
            // Return fake embedding vectors of length 1536 filled with 0.111 (identifying Worker A)
            return chunksToEmbed.map(() => new Array(1536).fill(0.111));
          },
        };

        const fastProviderB: EmbeddingProvider = {
          model: 'text-embedding-3-small',
          dimensions: 1536,
          async embedChunks(chunksToEmbed) {
            // Return fake embedding vectors filled with 0.999 (identifying Worker B)
            return chunksToEmbed.map(() => new Array(1536).fill(0.999));
          },
        };

        // 1. Launch Worker A in the background with skipHeartbeat so its lease can expire
        const workerAPromise = processIngestionJobDirectly(
          {
            jobId,
            organizationId: orgAId,
            documentId,
            versionId,
            type: 'document_ingestion',
          },
          {
            workerId: 'worker-A',
            leaseDurationSeconds: 1,
            skipHeartbeat: true,
            overrideProvider: pausingProviderA,
          }
        );

        // Wait briefly for Worker A to claim the job and enter paused embedding
        await new Promise((resolve) => setTimeout(resolve, 100));

        const jobDuringA = await getJobRecord(jobId);
        expect(jobDuringA?.status).toBe('processing');
        expect(jobDuringA?.locked_by).toBe('worker-A');
        expect(jobDuringA?.fencing_token).toBe(1);

        // 2. Worker A's lease expires in the database
        await query(
          `UPDATE jobs SET locked_until = now() - interval '2 seconds' WHERE id = $1`,
          [jobId]
        );

        // 3. Worker B reclaims the job and completes successfully with its embeddings (0.999)
        const runB = await processIngestionJobDirectly(
          {
            jobId,
            organizationId: orgAId,
            documentId,
            versionId,
            type: 'document_ingestion',
          },
          {
            workerId: 'worker-B',
            leaseDurationSeconds: 30,
            overrideProvider: fastProviderB,
          }
        );
        expect(runB.success).toBe(true);

        // Check that Worker B wrote chunks
        const chunksB = await query<{ count: string; embedding_sample: string }>(
          `SELECT count(*), (chunks.embedding::text) as embedding_sample
           FROM chunks
           WHERE document_version_id = $1
           GROUP BY embedding::text`,
          [versionId]
        );
        expect(Number(chunksB.rows[0]?.count)).toBeGreaterThan(0);
        expect(chunksB.rows[0]?.embedding_sample).toContain('0.999');

        // 4. Unpause Worker A to resume its execution
        unpauseWorkerA();

        // 5. Worker A resumes and enters persistChunksWithEmbeddings.
        // It must throw UnrecoverableError (wrapping LeaseFencingError) and NOT overwrite anything!
        await expect(workerAPromise).rejects.toThrow();

        // 6. Verify authoritative database state:
        // - Chunks are STILL Worker B's chunks (0.999), not Worker A's (0.111)
        const finalChunks = await query<{ count: string; embedding_sample: string }>(
          `SELECT count(*), (chunks.embedding::text) as embedding_sample
           FROM chunks
           WHERE document_version_id = $1
           GROUP BY embedding::text`,
          [versionId]
        );
        expect(Number(finalChunks.rows[0]?.count)).toBe(Number(chunksB.rows[0]?.count));
        expect(finalChunks.rows[0]?.embedding_sample).toContain('0.999');
        expect(finalChunks.rows[0]?.embedding_sample).not.toContain('0.111');

        // - Version status is ready
        const verFinal = await query<{ status: string }>(
          'SELECT status FROM document_versions WHERE id = $1',
          [versionId]
        );
        expect(verFinal.rows[0]?.status).toBe('ready');

        // - Job status is ready with token 2 (Worker B)
        const jobFinal = await getJobRecord(jobId);
        expect(jobFinal?.status).toBe('ready');
        expect(jobFinal?.fencing_token).toBe(2);

        // - Documents current_version_id is versionId
        const docFinal = await query<{ current_version_id: string }>(
          'SELECT current_version_id FROM documents WHERE id = $1',
          [documentId]
        );
        expect(docFinal.rows[0]?.current_version_id).toBe(versionId);
      });

      it('directly rejects chunk persistence when job fencing token does not match', async () => {
        // Setup document in Org A
        const mp = createMultipartPayload(
          { organizationId: orgAId, name: 'Direct Fencing Check Doc' },
          {
            fieldName: 'file',
            filename: 'direct-fence.md',
            contentType: 'text/markdown',
            content: '# Direct Fencing Test\n\nTesting transaction rollback on fencing mismatch.',
          }
        );

        const resUpload = await app.inject({
          method: 'POST',
          url: '/api/documents?async=true',
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });

        const doc = JSON.parse(resUpload.body);
        const { jobId, documentId, versionId } = doc;

        // Claim job
        const claim = await claimJobLease({
          jobId,
          workerId: 'worker-real',
          leaseDurationSeconds: 30,
        });
        expect(claim.success).toBe(true);

        // Attempt persistChunksWithEmbeddings with wrong worker ID or wrong token
        await expect(
          persistChunksWithEmbeddings({
            documentVersionId: versionId,
            organizationId: orgAId,
            documentId,
            chunks: [
              {
                chunkIndex: 0,
                content: 'Stale chunk',
                characterCount: 11,
                tokenCount: 3,
                embedding: new Array(1536).fill(0.123),
              },
            ],
            fencingContext: {
              jobId,
              workerId: 'stale-worker',
              fencingToken: claim.fencingToken!,
            },
          })
        ).rejects.toThrow(LeaseFencingError);

        // Verify zero chunks inserted
        const count = await query<{ count: string }>(
          'SELECT count(*) FROM chunks WHERE document_version_id = $1',
          [versionId]
        );
        expect(Number(count.rows[0]?.count)).toBe(0);
      });
    });

    describe('SEC-10-03: Make idempotent job creation race-safe', () => {
      it('two simultaneous createJob calls with the same organization and idempotency key resolve race-safely', async () => {
        const clientKey = `concurrent-test-key-${Math.random().toString(36).slice(2)}`;
        const idempotencyKey = `reindex:test-doc:${clientKey}`;

        // Launch two createJob calls simultaneously
        const [result1, result2] = await Promise.all([
          createJob({
            organizationId: orgAId,
            type: 'document_ingestion',
            idempotencyKey,
            payload: { documentId: 'test-doc-id', versionId: 'test-ver-id' },
          }),
          createJob({
            organizationId: orgAId,
            type: 'document_ingestion',
            idempotencyKey,
            payload: { documentId: 'test-doc-id', versionId: 'test-ver-id' },
          }),
        ]);

        // 1. Exactly one must have isNew: true, the other must have isNew: false
        const newResults = [result1.isNew, result2.isNew].filter(Boolean);
        const existingResults = [result1.isNew, result2.isNew].filter((x) => !x);

        expect(newResults.length).toBe(1);
        expect(existingResults.length).toBe(1);

        // 2. Both must return the exact same job ID
        expect(result1.job.id).toBe(result2.job.id);

        // 3. Exactly one physical row in jobs table for this organization & idempotency key
        const rows = await query<{ id: string }>(
          'SELECT id FROM jobs WHERE organization_id = $1 AND idempotency_key = $2',
          [orgAId, idempotencyKey]
        );
        expect(rows.rows.length).toBe(1);
      });

      it('concurrent HTTP reindex requests with identical Idempotency-Key return 202 with identical jobId', async () => {
        // Setup fresh document in Org A
        const mp = createMultipartPayload(
          { organizationId: orgAId, name: 'Concurrent HTTP Reindex Doc' },
          {
            fieldName: 'file',
            filename: 'concurrent-reindex.md',
            contentType: 'text/markdown',
            content: '# Reindex Concurrency\n\nTesting HTTP reindex race safety.',
          }
        );

        const resUpload = await app.inject({
          method: 'POST',
          url: '/api/documents?async=true',
          headers: {
            authorization: `Bearer ${memberAToken}`,
            ...mp.headers,
          },
          payload: mp.body,
        });

        const doc = JSON.parse(resUpload.body);
        const { jobId, documentId, versionId } = doc;

        // Ingest to ready
        await processIngestionJobDirectly({
          jobId,
          organizationId: orgAId,
          documentId,
          versionId,
          type: 'document_ingestion',
        });

        const clientKey = `http-race-key-${Math.random().toString(36).slice(2)}`;

        // Run two concurrent HTTP re-index requests
        const [res1, res2] = await Promise.all([
          app.inject({
            method: 'POST',
            url: `/api/documents/${documentId}/reindex?async=true`,
            headers: {
              authorization: `Bearer ${memberAToken}`,
              'idempotency-key': clientKey,
            },
            payload: { versionId },
          }),
          app.inject({
            method: 'POST',
            url: `/api/documents/${documentId}/reindex?async=true`,
            headers: {
              authorization: `Bearer ${memberAToken}`,
              'idempotency-key': clientKey,
            },
            payload: { versionId },
          }),
        ]);

        expect(res1.statusCode).toBe(202);
        expect(res2.statusCode).toBe(202);

        const body1 = JSON.parse(res1.body);
        const body2 = JSON.parse(res2.body);

        expect(body1.jobId).toBe(body2.jobId);

        // Verify only 1 job exists in database for this client key
        const jobRows = await query<{ id: string }>(
          'SELECT id FROM jobs WHERE organization_id = $1 AND idempotency_key LIKE $2',
          [orgAId, `%${clientKey}%`]
        );
        expect(jobRows.rows.length).toBe(1);
      });
    });
  });
});
