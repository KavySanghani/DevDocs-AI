import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { MockEmbeddingProvider } from '../src/services/ingestion/embeddingProvider.js';
import { ingestDocumentVersion } from '../src/services/ingestion/ingestionService.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

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

describe('Phase 5: Document Ingestion, pgvector Embeddings & Chunk Persistence API', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_ingestion_suite_32_chars!';

  let orgAId: string;
  let orgBId: string;

  let adminAToken: string;
  let memberAToken: string;
  let viewerAToken: string;
  let adminBToken: string;

  let sampleMarkdownDocId: string;
  let sampleMarkdownVersionId: string;

  beforeAll(async () => {
    // Reset test database safely
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
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
      EMBEDDING_PROVIDER: 'mock',
    });

    app = await buildApp({ env: testEnv });
    await app.ready();

    // Register test accounts
    async function register(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'SecurePassword123!' },
      });
      const body = JSON.parse(res.body);
      return { token: body.token as string, userId: body.user.id as string };
    }

    const adminA = await register('admin_a@tenant.com');
    adminAToken = adminA.token;

    const memberA = await register('member_a@tenant.com');
    memberAToken = memberA.token;

    const viewerA = await register('viewer_a@tenant.com');
    viewerAToken = viewerA.token;

    const adminB = await register('admin_b@other.com');
    adminBToken = adminB.token;

    // Create Organization A
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'Acme Cloud Engineering' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add Member & Viewer to Org A
    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'member_a@tenant.com', role: 'member' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'viewer_a@tenant.com', role: 'viewer' },
    });

    // Create Organization B
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminBToken}` },
      payload: { name: 'Beta Analytics Corp' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. Auto-Ingestion on Upload & pgvector Storage', () => {
    it('uploads Markdown and auto-ingests into chunks with 1536-dim vector embeddings', async () => {
      const markdown = [
        '# Infrastructure Architecture Guide',
        'Overview of cloud services and container orchestration.',
        '',
        '## Database Cluster',
        'PostgreSQL with pgvector handles embedding indexing with HNSW cosine distance metric.',
        '',
        '## Ingestion Microservice',
        'Node.js 22 worker pool parsing documents, generating tokens, and persisting chunks atomically.',
      ].join('\n');

      const multipart = createMultipartPayload(
        { organizationId: orgAId, name: 'Infra Guide' },
        { fieldName: 'file', filename: 'infra.md', contentType: 'text/markdown', content: markdown }
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

      expect(body.document.status).toBe('ready');
      expect(body.document.sourceDetails).toBeDefined();
      expect(body.document.sourceDetails.chunkCount).toBeGreaterThan(0);

      sampleMarkdownDocId = body.document.id;
      sampleMarkdownVersionId = body.document.currentVersionId;

      // Query PostgreSQL chunks table directly
      const chunksDbRes = await query<{
        id: string;
        chunk_index: number;
        content: string;
        embedding: string;
        token_count: number;
        character_count: number;
        section_title: string;
        search_vector: string;
      }>(
        `SELECT id, chunk_index, content, embedding::text, token_count, character_count, section_title, search_vector::text
         FROM chunks
         WHERE document_version_id = $1
         ORDER BY chunk_index ASC`,
        [sampleMarkdownVersionId]
      );

      expect(chunksDbRes.rows.length).toBeGreaterThanOrEqual(2);

      const firstChunk = chunksDbRes.rows[0]!;
      expect(firstChunk.chunk_index).toBe(0);
      expect(firstChunk.section_title).toBe('Infrastructure Architecture Guide');
      expect(firstChunk.token_count).toBeGreaterThan(0);
      expect(firstChunk.character_count).toBeGreaterThan(0);

      // Verify embedding vector string format [x,y,...] with 1536 dimensions
      expect(firstChunk.embedding.startsWith('[')).toBe(true);
      expect(firstChunk.embedding.endsWith(']')).toBe(true);
      const dims = firstChunk.embedding.slice(1, -1).split(',');
      expect(dims.length).toBe(1536);

      // Verify generated search_vector tsvector is populated
      expect(firstChunk.search_vector).toContain("'infrastructur'");
    });

    it('performs cosine distance vector search (<=>) directly using pgvector', async () => {
      const mockProvider = new MockEmbeddingProvider();
      const queryText = 'PostgreSQL database cluster and pgvector';
      const [queryVector] = await mockProvider.embedChunks([queryText]);

      const vectorParam = `[${queryVector!.join(',')}]`;

      const searchRes = await query<{
        chunk_index: number;
        content: string;
        section_title: string;
        distance: number;
      }>(
        `SELECT chunk_index, content, section_title, (embedding <=> $1::vector) AS distance
         FROM chunks
         WHERE document_version_id = $2
         ORDER BY distance ASC
         LIMIT 1`,
        [vectorParam, sampleMarkdownVersionId]
      );

      expect(searchRes.rows.length).toBe(1);
      const match = searchRes.rows[0]!;
      expect(match.section_title).toBeDefined();
      expect(typeof match.distance).toBe('number');
      expect(match.distance).toBeGreaterThanOrEqual(0);
    });
  });

  describe('2. GET /api/documents/:id/chunks (Paginated Chunk Listing)', () => {
    it('retrieves paginated chunks with total, page, limit, and totalPages metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${sampleMarkdownDocId}/chunks?page=1&limit=2`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(Array.isArray(body.chunks)).toBe(true);
      expect(body.chunks.length).toBeLessThanOrEqual(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(body.totalPages).toBeGreaterThanOrEqual(1);

      const chunk = body.chunks[0];
      expect(chunk.id).toBeDefined();
      expect(chunk.chunkIndex).toBe(0);
      expect(chunk.content).toBeDefined();
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.characterCount).toBeGreaterThan(0);
    });

    it('enforces tenant isolation and returns 404 to non-member organizations', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${sampleMarkdownDocId}/chunks`,
        headers: { authorization: `Bearer ${adminBToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('3. POST /api/documents/:id/ingest (Trigger & Re-ingestion)', () => {
    it('re-ingests document idempotently with custom chunk configuration', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${sampleMarkdownDocId}/ingest`,
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          config: {
            maxChunkSizeChars: 400,
            chunkOverlapChars: 60,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.ingestion).toBeDefined();
      expect(body.ingestion.status).toBe('ready');
      expect(body.ingestion.chunkCount).toBeGreaterThan(0);
      expect(body.ingestion.totalEstimatedTokens).toBeGreaterThan(0);
      expect(body.ingestion.embeddingModel).toBeDefined();

      // Check PostgreSQL that old chunks were replaced without duplicate key errors
      const chunksDbRes = await query<{ count: string }>(
        'SELECT count(*) FROM chunks WHERE document_version_id = $1',
        [sampleMarkdownVersionId]
      );
      expect(parseInt(chunksDbRes.rows[0]!.count, 10)).toBe(body.ingestion.chunkCount);
    });

    it('rejects viewer role with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${sampleMarkdownDocId}/ingest`,
        headers: { authorization: `Bearer ${viewerAToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('returns 404 for non-existent document or unauthorized organization', async () => {
      const fakeDocId = '00000000-0000-0000-0000-000000000000';
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${fakeDocId}/ingest`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('4. Failure Handling & Atomic Rollback', () => {
    it('marks version as FAILED and never stores chunks when embedding provider fails', async () => {
      // Create a new document in processing state with extracted text
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, name, source_type)
         VALUES ($1, 'Failing Ingestion Doc', 'text')
         RETURNING id`,
        [orgAId]
      );
      const docId = docRes.rows[0]!.id;

      const versionRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
         VALUES ($1, 1, 'fake_hash_123', 'processing', $2)
         RETURNING id`,
        [docId, JSON.stringify({ rawText: 'Extracted plain text for testing failed embedding stage.' })]
      );
      const versionId = versionRes.rows[0]!.id;

      await query('UPDATE documents SET current_version_id = $1 WHERE id = $2', [versionId, docId]);

      const failingProvider = new MockEmbeddingProvider({
        simulatedError: 'OpenAI API 503 Service Unavailable',
      });

      await expect(
        ingestDocumentVersion({
          documentId: docId,
          documentVersionId: versionId,
          organizationId: orgAId,
          provider: failingProvider,
        })
      ).rejects.toThrow(/OpenAI API 503 Service Unavailable/);

      // Verify version in DB is marked 'failed' with error details
      const dbVersionRes = await query<{
        status: string;
        error_message: string;
        source_details: { errorStage: string };
      }>(
        'SELECT status, error_message, source_details FROM document_versions WHERE id = $1',
        [versionId]
      );

      const version = dbVersionRes.rows[0]!;
      expect(version.status).toBe('failed');
      expect(version.error_message).toContain('OpenAI API 503');
      expect(version.source_details.errorStage).toBe('embedding');

      // Verify chunks table has NO chunks persisted
      const chunksCountRes = await query<{ count: string }>(
        'SELECT count(*) FROM chunks WHERE document_version_id = $1',
        [versionId]
      );
      expect(parseInt(chunksCountRes.rows[0]!.count, 10)).toBe(0);

      // Repair the document by re-running with working mock provider
      const repairRes = await ingestDocumentVersion({
        documentId: docId,
        documentVersionId: versionId,
        organizationId: orgAId,
      });

      expect(repairRes.status).toBe('ready');
      expect(repairRes.chunkCount).toBeGreaterThan(0);
    });
  });
});
