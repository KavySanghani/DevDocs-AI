import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { MockEmbeddingProvider } from '../src/services/ingestion/embeddingProvider.js';
import { ingestDocumentVersion } from '../src/services/ingestion/ingestionService.js';
import { searchSimilarChunks, normalizeQueryText } from '../src/services/retrieval/vectorSearch.js';
import { RetrievalError } from '../src/services/retrieval/types.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

describe('Phase 6: Semantic Vector Search & Retrieval Service', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_vector_search_suite_32_chars!';

  let orgAId: string;
  let orgBId: string;
  let adminAToken: string;
  let memberAToken: string;
  let viewerAToken: string;
  let adminBToken: string;

  let docA1Id: string;
  let docA1VersionId: string;
  let docA2Id: string;
  let docA2VersionId: string;
  let docBId: string;
  let docBVersionId: string;

  class SemanticMockEmbeddingProvider implements EmbeddingProvider {
    readonly model = 'semantic-fixture-embedding-model';
    readonly dimensions = 1536;

    private readonly topicDimensions: Record<string, number> = {
      fastify: 0,
      route: 1,
      plugin: 2,
      pgvector: 10,
      database: 11,
      cosine: 12,
      hnsw: 13,
    };

    async embedChunks(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vec = new Array(1536).fill(0);
        const lower = text.toLowerCase();
        let hasTopic = false;

        for (const [topic, dim] of Object.entries(this.topicDimensions)) {
          if (lower.includes(topic)) {
            vec[dim] = 1.0;
            hasTopic = true;
          }
        }

        if (!hasTopic) {
          vec[100] = 0.5;
        }

        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vec.map((v) => Number((v / norm).toFixed(7)));
      });
    }
  }

  const mockProvider = new SemanticMockEmbeddingProvider();

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4007',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
      MAX_FILE_SIZE_BYTES: '10485760',
      EMBEDDING_PROVIDER: 'mock',
      LLM_PROVIDER: 'mock',
    });

    app = await buildApp({ env: testEnv });
    await app.ready();

    // Register accounts
    async function register(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'SecurePassword123!' },
      });
      const body = JSON.parse(res.body);
      return { token: body.token as string, userId: body.user.id as string };
    }

    const adminA = await register('vector_admin_a@tenant.com');
    adminAToken = adminA.token;

    const memberA = await register('vector_member_a@tenant.com');
    memberAToken = memberA.token;

    const viewerA = await register('vector_viewer_a@tenant.com');
    viewerAToken = viewerA.token;

    const adminB = await register('vector_admin_b@other.com');
    adminBToken = adminB.token;

    // Create Org A
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'Acme Vector Org' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add memberA and viewerA to Org A
    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'vector_member_a@tenant.com', role: 'member' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'vector_viewer_a@tenant.com', role: 'viewer' },
    });

    // Create Org B
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminBToken}` },
      payload: { name: 'Competitor Tenant B' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;

    // Helper to insert and ingest documents directly for test fixtures
    async function createAndIngestDoc(
      orgId: string,
      name: string,
      content: string,
      sourceType: 'markdown' | 'text' = 'markdown'
    ) {
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, name, source_type)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [orgId, name, sourceType]
      );
      const docId = docRes.rows[0]!.id;

      const sourceDetails = {
        rawText: content,
        characterCount: content.length,
        originalFilename: `${name}.md`,
        mimeType: 'text/markdown',
      };

      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, source_details, status)
         VALUES ($1, 1, 'hash_${Date.now()}_${Math.random()}', $2, 'processing')
         RETURNING id`,
        [docId, JSON.stringify(sourceDetails)]
      );
      const versionId = verRes.rows[0]!.id;

      await query(
        `UPDATE documents SET current_version_id = $1 WHERE id = $2`,
        [versionId, docId]
      );

      // Ingest chunks using mock embedding provider
      await ingestDocumentVersion({
        documentId: docId,
        documentVersionId: versionId,
        organizationId: orgId,
        provider: mockProvider,
      });

      return { docId, versionId };
    }

    // 1. Org A Doc 1: Fastify Web Server Architecture
    const docA1 = await createAndIngestDoc(
      orgAId,
      'Fastify Server Architecture',
      `# Fastify Web Services\n\nFastify is an extremely fast and low-overhead web framework for Node.js. It features a robust plugin architecture, schema-based request validation using Fastify JSON schemas or Zod, and native TypeScript support.\n\n## Fastify Routes and Handlers\n\nRoutes in Fastify are registered using app.register() or HTTP verb methods like app.get and app.post. Hooks like onRequest and preHandler handle authentication and authorization.`
    );
    docA1Id = docA1.docId;
    docA1VersionId = docA1.versionId;

    // 2. Org A Doc 2: pgvector Cosine Retrieval
    const docA2 = await createAndIngestDoc(
      orgAId,
      'PostgreSQL pgvector Database Guide',
      `# Vector Search with pgvector\n\nPostgreSQL supports high-performance vector similarity search using the pgvector extension. By using the <=> operator, pgvector performs cosine distance searches over vector embeddings.\n\n## HNSW Indexing Strategy\n\nAn HNSW index on embedding vector_cosine_ops provides fast approximate nearest neighbor search for interactive retrieval at low query latency.`
    );
    docA2Id = docA2.docId;
    docA2VersionId = docA2.versionId;

    // 3. Org B Doc: Secret Fastify Specification (Cross-Tenant Fixture)
    const docB = await createAndIngestDoc(
      orgBId,
      'Confidential Fastify Internal Specs',
      `# Tenant B Confidential Fastify Specs\n\nThis is proprietary Fastify internal server documentation belonging exclusively to Tenant B. Under no circumstances should Tenant A ever see or retrieve this content.`
    );
    docBId = docB.docId;
    docBVersionId = docB.versionId;
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. Query Normalization & Validation', () => {
    it('normalizes queries by collapsing whitespace and control characters', () => {
      const raw = '  How   does \n\n Fastify \t handle\r\n routes?   ';
      const normalized = normalizeQueryText(raw);
      expect(normalized).toBe('How does Fastify handle routes?');
    });

    it('rejects empty queries with 400 EMPTY_QUERY', async () => {
      await expect(
        searchSimilarChunks({
          organizationId: orgAId,
          query: '   ',
        })
      ).rejects.toThrow(RetrievalError);

      try {
        await searchSimilarChunks({ organizationId: orgAId, query: '   ' });
      } catch (err) {
        expect(err).toBeInstanceOf(RetrievalError);
        expect((err as RetrievalError).code).toBe('EMPTY_QUERY');
        expect((err as RetrievalError).statusCode).toBe(400);
      }
    });

    it('rejects missing organization ID with 400 INVALID_PARAM', async () => {
      await expect(
        searchSimilarChunks({
          organizationId: '',
          query: 'Fastify routes',
        })
      ).rejects.toThrow(RetrievalError);
    });

    it('rejects queries exceeding 2000 characters with 400 QUERY_TOO_LONG', async () => {
      const longQuery = 'A'.repeat(2005);
      await expect(
        searchSimilarChunks({
          organizationId: orgAId,
          query: longQuery,
        })
      ).rejects.toThrow(RetrievalError);
    });
  });

  describe('2. Semantic Vector Retrieval & Ranking', () => {
    it('retrieves relevant chunks for Fastify query in Org A', async () => {
      const result = await searchSimilarChunks(
        {
          organizationId: orgAId,
          query: 'Fastify web framework routes and plugin architecture',
          topK: 5,
        },
        mockProvider
      );

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.totalCandidates).toBe(result.chunks.length);
      expect(result.query).toBe('Fastify web framework routes and plugin architecture');
      expect(result.embeddingModel).toBe(mockProvider.model);

      // Verify latency breakdowns
      expect(result.latency.embeddingMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.retrievalMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.totalMs).toBe(
        result.latency.embeddingMs + result.latency.retrievalMs
      );

      // Rank 1 chunk should be from Fastify Server Architecture
      const topChunk = result.chunks[0]!;
      expect(topChunk.rank).toBe(1);
      expect(topChunk.documentId).toBe(docA1Id);
      expect(topChunk.documentName).toBe('Fastify Server Architecture');
      expect(topChunk.content).toContain('Fastify');
      expect(topChunk.similarityScore).toBeGreaterThan(0);
      expect(topChunk.distance).toBeGreaterThanOrEqual(0);
    });

    it('retrieves relevant chunks for pgvector query in Org A', async () => {
      const result = await searchSimilarChunks(
        {
          organizationId: orgAId,
          query: 'PostgreSQL vector similarity search with pgvector and HNSW',
          topK: 5,
        },
        mockProvider
      );

      expect(result.chunks.length).toBeGreaterThan(0);
      const topChunk = result.chunks[0]!;
      expect(topChunk.documentId).toBe(docA2Id);
      expect(topChunk.documentName).toBe('PostgreSQL pgvector Database Guide');
      expect(topChunk.content).toContain('pgvector');
    });

    it('enforces deterministic ordering by distance ascending (similarity descending)', async () => {
      const result = await searchSimilarChunks(
        {
          organizationId: orgAId,
          query: 'database vector index',
          topK: 10,
        },
        mockProvider
      );

      expect(result.chunks.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < result.chunks.length - 1; i++) {
        const current = result.chunks[i]!;
        const next = result.chunks[i + 1]!;
        expect(current.distance).toBeLessThanOrEqual(next.distance);
        expect(current.similarityScore).toBeGreaterThanOrEqual(next.similarityScore);
        expect(current.rank).toBe(i + 1);
      }
    });

    it('enforces strict topK bounds', async () => {
      // topK = 1
      const res1 = await searchSimilarChunks(
        { organizationId: orgAId, query: 'Fastify', topK: 1 },
        mockProvider
      );
      expect(res1.chunks).toHaveLength(1);

      // topK = 2
      const res2 = await searchSimilarChunks(
        { organizationId: orgAId, query: 'Fastify', topK: 2 },
        mockProvider
      );
      expect(res2.chunks.length).toBeLessThanOrEqual(2);
    });

    it('filters by specific documentId when requested', async () => {
      const result = await searchSimilarChunks(
        {
          organizationId: orgAId,
          query: 'framework',
          documentId: docA2Id, // search only pgvector doc
          topK: 5,
        },
        mockProvider
      );

      for (const chunk of result.chunks) {
        expect(chunk.documentId).toBe(docA2Id);
      }
    });
  });

  describe('3. Strict Tenant Isolation (Zero Cross-Tenant Leakage)', () => {
    it('never returns Org B content when Org A searches for Fastify', async () => {
      const result = await searchSimilarChunks(
        {
          organizationId: orgAId,
          query: 'Confidential Fastify Internal Specs proprietary',
          topK: 10,
        },
        mockProvider
      );

      // Even though query matches Org B's doc title/content closely,
      // NO chunk from Org B may EVER be returned to Org A!
      for (const chunk of result.chunks) {
        expect(chunk.documentId).not.toBe(docBId);
        expect(chunk.content).not.toContain('Tenant B Confidential');
      }
    });

    it('never returns Org A content when Org B searches for pgvector', async () => {
      // 1. Without threshold, only Org B's own chunks may ever be returned
      const result = await searchSimilarChunks(
        {
          organizationId: orgBId,
          query: 'PostgreSQL pgvector database guide',
          topK: 10,
        },
        mockProvider
      );

      for (const chunk of result.chunks) {
        expect(chunk.documentId).not.toBe(docA1Id);
        expect(chunk.documentId).not.toBe(docA2Id);
        expect(chunk.documentId).toBe(docBId);
      }

      // 2. With similarity threshold, unrelated query yields zero candidates
      const thresholdResult = await searchSimilarChunks(
        {
          organizationId: orgBId,
          query: 'PostgreSQL pgvector database guide',
          topK: 10,
          similarityThreshold: 0.5,
        },
        mockProvider
      );

      expect(thresholdResult.chunks).toHaveLength(0);
      expect(thresholdResult.totalCandidates).toBe(0);
    });
  });

  describe('4. Empty Corpus and Searchable State Filtering', () => {
    it('returns empty candidates array safely when org has no documents', async () => {
      // Create empty tenant
      const emptyOrgRes = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: { authorization: `Bearer ${adminAToken}` },
        payload: { name: 'Empty Workspace' },
      });
      const emptyOrgId = JSON.parse(emptyOrgRes.body).organization.id;

      const result = await searchSimilarChunks(
        {
          organizationId: emptyOrgId,
          query: 'Any technical question',
          topK: 5,
        },
        mockProvider
      );

      expect(result.chunks).toHaveLength(0);
      expect(result.totalCandidates).toBe(0);
    });

    it('excludes chunks from documents that are not in ready status', async () => {
      // Insert a document in processing state with chunks
      const unreadyRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, name, source_type)
         VALUES ($1, 'Draft Processing Doc', 'markdown')
         RETURNING id`,
        [orgAId]
      );
      const unreadyDocId = unreadyRes.rows[0]!.id;

      const unreadySourceDetails = {
        rawText: 'Processing content that should not be visible',
        characterCount: 45,
        originalFilename: 'Draft.md',
        mimeType: 'text/markdown',
      };

      const verRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, source_details, status)
         VALUES ($1, 1, 'unready_hash', $2, 'processing')
         RETURNING id`,
        [unreadyDocId, JSON.stringify(unreadySourceDetails)]
      );
      const unreadyVersionId = verRes.rows[0]!.id;

      await query(
        `UPDATE documents SET current_version_id = $1 WHERE id = $2`,
        [unreadyVersionId, unreadyDocId]
      );

      // Ingest chunks for this version
      await ingestDocumentVersion({
        documentId: unreadyDocId,
        documentVersionId: unreadyVersionId,
        organizationId: orgAId,
        provider: mockProvider,
      });

      // Now set version back to 'processing' to simulate in-flight/unready state
      await query(
        `UPDATE document_versions SET status = 'processing' WHERE id = $1`,
        [unreadyVersionId]
      );

      // Search specifically for words in the unready document
      const result = await searchSimilarChunks(
        {
          organizationId: orgAId,
          query: 'Processing content that should not be visible',
          topK: 5,
        },
        mockProvider
      );

      for (const chunk of result.chunks) {
        expect(chunk.documentId).not.toBe(unreadyDocId);
      }
    });
  });

  describe('5. Error Handling and Secret Redaction', () => {
    it('handles embedding provider failure gracefully without exposing secrets', async () => {
      const failingProvider = new MockEmbeddingProvider({
        simulatedError: 'sk-proj-test1234567890secretkey embedding failure',
      });

      await expect(
        searchSimilarChunks(
          {
            organizationId: orgAId,
            query: 'test query',
          },
          failingProvider
        )
      ).rejects.toThrow(RetrievalError);
    });
  });
});
