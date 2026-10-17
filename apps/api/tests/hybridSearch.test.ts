import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import type { EmbeddingProvider } from '../src/services/ingestion/types.js';
import { ingestDocumentVersion } from '../src/services/ingestion/ingestionService.js';
import {
  searchLexicalChunks,
  searchHybridChunks,
  RetrievalError,
} from '../src/services/retrieval/index.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

describe('Phase 7: Hybrid Search, PostgreSQL Full-Text Search, and RRF Integration Tests', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_hybrid_search_suite_32_chars!';

  let orgAId: string;
  let orgBId: string;
  let adminAToken: string;
  let viewerAToken: string;
  let nonMemberToken: string;

  let docA1Id: string;
  let docA1VersionId: string;
  let docA2Id: string;
  let docA2VersionId: string;
  let docBId: string;
  let docBVersionId: string;

  class HybridSemanticMockProvider implements EmbeddingProvider {
    readonly model = 'hybrid-fixture-embedding-model';
    readonly dimensions = 1536;

    private readonly topicDimensions: Record<string, number> = {
      container: 0,
      kubernetes: 1,
      orchestration: 2,
      autoscaling: 3,
      api: 10,
      ingest: 11,
      payment: 12,
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

  const mockProvider = new HybridSemanticMockProvider();

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4009',
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

    // Register test accounts
    async function register(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'SecurePassword123!' },
      });
      return JSON.parse(res.body).token as string;
    }

    adminAToken = await register('hybrid_admin_a@test.com');
    viewerAToken = await register('hybrid_viewer_a@test.com');
    const adminBToken = await register('hybrid_admin_b@test.com');
    nonMemberToken = await register('hybrid_nonmember@test.com');

    // Create Org A
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'Acme Corp Org A' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add viewer to Org A
    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'hybrid_viewer_a@test.com', role: 'viewer' },
    });

    // Create Org B
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminBToken}` },
      payload: { name: 'Competitor Corp Org B' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;

    // Ingest helper
    async function createAndIngestDoc(
      orgId: string,
      name: string,
      content: string,
      metadata: Record<string, unknown> = {}
    ) {
      const docRes = await query<{ id: string }>(
        `INSERT INTO documents (organization_id, name, source_type)
         VALUES ($1, $2, 'markdown')
         RETURNING id`,
        [orgId, name]
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

      await ingestDocumentVersion({
        documentId: docId,
        documentVersionId: versionId,
        organizationId: orgId,
        provider: mockProvider,
      });

      // Update metadata on chunks if provided
      if (Object.keys(metadata).length > 0) {
        await query(
          `UPDATE chunks SET metadata = $1 WHERE document_version_id = $2`,
          [JSON.stringify(metadata), versionId]
        );
      }

      return { docId, versionId };
    }

    // Doc A1: Technical API & code identifiers
    const docA1 = await createAndIngestDoc(
      orgAId,
      'API Reference Guide',
      `# DevDocs AI API Reference
This guide documents the core endpoints and error responses.
The main ingestion endpoint is POST /api/documents/:id/ingest.
If payment authentication fails, it raises error code ERR_PAYMENT_FAILED immediately.
Tax calculation is handled by internal function calculateTaxAmount(amount, rate).
Uses PostgreSQL search_vector and Reciprocal Rank Fusion for hybrid retrieval.`,
      { category: 'api', environment: 'production' }
    );
    docA1Id = docA1.docId;
    docA1VersionId = docA1.versionId;

    // Doc A2: Conceptual Infrastructure Guide
    const docA2 = await createAndIngestDoc(
      orgAId,
      'Infrastructure & Orchestration Guide',
      `# Microservices and Container Infrastructure
Production workloads run on managed Kubernetes clusters with Docker container isolation.
Enables horizontal pod autoscaling, zero-downtime rolling deployments, and container networking.
Automated health probes ensure high service availability across multiple availability zones.`,
      { category: 'infrastructure', environment: 'production' }
    );
    docA2Id = docA2.docId;
    docA2VersionId = docA2.versionId;

    // Doc B: Identical exact keywords in Org B (for strict tenant isolation verification)
    const docB = await createAndIngestDoc(
      orgBId,
      'Org B Secret Document',
      `# Competitor Secret API
Contains identical endpoint POST /api/documents/:id/ingest.
Throws error code ERR_PAYMENT_FAILED in Org B.
Confidential competitor trade secret calculateTaxAmount.`,
      { category: 'secret' }
    );
    docBId = docB.docId;
    docBVersionId = docB.versionId;
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. Lexical Search (PostgreSQL Full-Text Search)', () => {
    it('retrieves exact API route names (/api/documents/:id/ingest)', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: 'POST /api/documents/:id/ingest',
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]!.documentName).toBe('API Reference Guide');
      expect(result.chunks[0]!.content).toContain('POST /api/documents/:id/ingest');
      expect(result.chunks[0]!.lexicalRank).toBe(1);
      expect(result.chunks[0]!.lexicalScore).toBeGreaterThan(0);
      expect(result.chunks[0]!.vectorRank).toBeNull();
      expect(result.latency.retrievalMs).toBeGreaterThanOrEqual(0);
    });

    it('retrieves exact technical function identifiers (calculateTaxAmount)', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: 'calculateTaxAmount',
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]!.documentName).toBe('API Reference Guide');
      expect(result.chunks[0]!.content).toContain('calculateTaxAmount');
      expect(result.chunks[0]!.lexicalRank).toBe(1);
    });

    it('retrieves exact error codes (ERR_PAYMENT_FAILED)', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: 'ERR_PAYMENT_FAILED',
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]!.documentName).toBe('API Reference Guide');
      expect(result.chunks[0]!.content).toContain('ERR_PAYMENT_FAILED');
    });

    it('supports phrases with quotation marks', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: '"Reciprocal Rank Fusion"',
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]!.content).toContain('Reciprocal Rank Fusion');
    });

    it('supports boolean OR websearch syntax', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: 'ERR_PAYMENT_FAILED or Kubernetes',
      });

      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('safely returns 0 candidates for non-existent keywords without failing', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: 'non_existent_keyword_xyz_123456789',
      });

      expect(result.chunks).toEqual([]);
      expect(result.totalCandidates).toBe(0);
    });
  });

  describe('2. Hybrid Search & Reciprocal Rank Fusion (RRF)', () => {
    it('executes hybrid retrieval combining vector and lexical rankings', async () => {
      const result = await searchHybridChunks(
        {
          organizationId: orgAId,
          query: 'POST /api/documents/:id/ingest container pod orchestration',
          mode: 'hybrid',
          topK: 5,
        },
        mockProvider
      );

      expect(result.mode).toBe('hybrid');
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.rrfK).toBe(60);

      // Verify diagnostics on returned chunks
      for (const chunk of result.chunks) {
        expect(chunk.rank).toBeGreaterThanOrEqual(1);
        expect(typeof chunk.rrfScore).toBe('number');
        expect(chunk.rrfScore).toBeGreaterThan(0);
        expect(chunk.score).toBe(chunk.rrfScore);
      }

      // Latency breakdown includes embeddingMs, retrievalMs, and fusionMs
      expect(result.latency.embeddingMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.retrievalMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.fusionMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('boosts overlapping candidates appearing in both vector and keyword results', async () => {
      // Query tailored to match Doc A1 in both vector (topic 'api', 'ingest') and keyword ('POST /api/documents/:id/ingest')
      const result = await searchHybridChunks(
        {
          organizationId: orgAId,
          query: 'POST /api/documents/:id/ingest API reference',
          mode: 'hybrid',
        },
        mockProvider
      );

      expect(result.chunks.length).toBeGreaterThan(0);
      const topChunk = result.chunks[0]!;
      expect(topChunk.documentName).toBe('API Reference Guide');
      // Overlapping candidate must have both vectorRank and lexicalRank populated
      expect(topChunk.vectorRank).not.toBeNull();
      expect(topChunk.lexicalRank).not.toBeNull();
      expect(topChunk.vectorScore).toBeGreaterThan(0);
      expect(topChunk.lexicalScore).toBeGreaterThan(0);
    });

    it('supports vector-only mode via hybrid search service', async () => {
      const result = await searchHybridChunks(
        {
          organizationId: orgAId,
          query: 'Kubernetes container pod autoscaling',
          mode: 'vector',
          topK: 3,
        },
        mockProvider
      );

      expect(result.mode).toBe('vector');
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]!.documentName).toBe('Infrastructure & Orchestration Guide');
      expect(result.chunks[0]!.vectorRank).toBe(1);
      expect(result.chunks[0]!.lexicalRank).toBeNull();
      expect(result.chunks[0]!.similarityScore).toBeGreaterThan(0);
    });

    it('supports keyword-only mode via hybrid search service', async () => {
      const result = await searchHybridChunks(
        {
          organizationId: orgAId,
          query: 'calculateTaxAmount',
          mode: 'keyword',
          topK: 3,
        },
        mockProvider
      );

      expect(result.mode).toBe('keyword');
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]!.documentName).toBe('API Reference Guide');
      expect(result.chunks[0]!.lexicalRank).toBe(1);
      expect(result.chunks[0]!.vectorRank).toBeNull();
      expect(result.latency.embeddingMs).toBe(0); // Zero embedding latency in keyword mode
    });
  });

  describe('3. Multi-Tenant Isolation & Security', () => {
    it('prevents cross-tenant candidate leakage in lexical search even with identical keywords', async () => {
      const result = await searchLexicalChunks({
        organizationId: orgAId,
        query: 'calculateTaxAmount',
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      // All returned chunks must belong exclusively to Org A
      for (const chunk of result.chunks) {
        expect(chunk.documentId).not.toBe(docBId);
        expect(chunk.documentName).not.toContain('Org B');
      }
    });

    it('prevents cross-tenant candidate leakage in hybrid search', async () => {
      const result = await searchHybridChunks(
        {
          organizationId: orgAId,
          query: 'POST /api/documents/:id/ingest ERR_PAYMENT_FAILED',
          mode: 'hybrid',
        },
        mockProvider
      );

      expect(result.chunks.length).toBeGreaterThan(0);
      for (const chunk of result.chunks) {
        expect(chunk.documentId).not.toBe(docBId);
        expect(chunk.documentName).not.toBe('Org B Secret Document');
      }
    });

    it('excludes non-ready document versions from search results', async () => {
      // Create a processing version in Org A (non-ready status)
      const draftRes = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, version_number, content_hash, source_details, status)
         VALUES ($1, 2, 'hash_draft_version', '{}'::jsonb, 'processing')
         RETURNING id`,
        [docA1Id]
      );
      const draftVersionId = draftRes.rows[0]!.id;

      // Add a chunk to the non-ready version with unique term
      await query(
        `INSERT INTO chunks (document_version_id, chunk_index, content)
         VALUES ($1, 0, 'DRAFT_SECRET_KEYWORD_NOT_READY')`,
        [draftVersionId]
      );

      const result = await searchHybridChunks({
        organizationId: orgAId,
        query: 'DRAFT_SECRET_KEYWORD_NOT_READY',
        mode: 'keyword',
      });

      expect(result.chunks).toEqual([]);
    });

    it('filters strictly by documentId when provided', async () => {
      // Both Doc A1 and Doc A2 are in Org A, but documentId filters strictly to Doc A1
      const result = await searchHybridChunks(
        {
          organizationId: orgAId,
          query: 'DevDocs API Reference',
          documentId: docA1Id,
          mode: 'hybrid',
        },
        mockProvider
      );

      expect(result.chunks.length).toBeGreaterThan(0);
      for (const chunk of result.chunks) {
        expect(chunk.documentId).toBe(docA1Id);
      }
    });

    it('filters by metadata JSONB containment when provided', async () => {
      const result = await searchHybridChunks({
        organizationId: orgAId,
        query: 'calculateTaxAmount',
        mode: 'keyword',
        metadataFilter: { category: 'api' },
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      for (const chunk of result.chunks) {
        expect(chunk.documentName).toBe('API Reference Guide');
      }
    });
  });

  describe('4. Input Validation & Error Handling', () => {
    it('rejects empty query string with 400', async () => {
      await expect(
        searchHybridChunks({ organizationId: orgAId, query: '   ' })
      ).rejects.toThrow(RetrievalError);
    });

    it('rejects query exceeding 2000 characters with 400', async () => {
      await expect(
        searchHybridChunks({
          organizationId: orgAId,
          query: 'a'.repeat(2001),
        })
      ).rejects.toThrow(RetrievalError);
    });

    it('rejects invalid retrieval mode with 400', async () => {
      await expect(
        searchHybridChunks({
          organizationId: orgAId,
          query: 'test query',
          // @ts-expect-error Testing invalid runtime value
          mode: 'unsupported_mode',
        })
      ).rejects.toThrow(RetrievalError);
    });
  });

  describe('5. Search HTTP API Endpoints', () => {
    it('POST /api/search with header X-Organization-Id returns hybrid results with diagnostics', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        headers: {
          authorization: `Bearer ${viewerAToken}`,
          'x-organization-id': orgAId,
        },
        payload: {
          query: 'POST /api/documents/:id/ingest calculateTaxAmount',
          mode: 'hybrid',
          topK: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.mode).toBe('hybrid');
      expect(Array.isArray(data.chunks)).toBe(true);
      expect(data.chunks.length).toBeGreaterThan(0);
      expect(data.chunks[0].id).toBeDefined();
      expect(data.chunks[0].documentId).toBe(docA1Id);
      expect(data.chunks[0].rrfScore).toBeDefined();
      expect(data.chunks[0].rank).toBe(1);
      expect(data.latency.totalMs).toBeDefined();
    });

    it('POST /api/search rejects unauthorized user without organization membership (404)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        headers: {
          authorization: `Bearer ${nonMemberToken}`,
          'x-organization-id': orgAId,
        },
        payload: {
          query: 'POST /api/documents/:id/ingest',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('POST /api/search rejects missing organization ID with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        headers: {
          authorization: `Bearer ${viewerAToken}`,
        },
        payload: {
          query: 'POST /api/documents/:id/ingest',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('MISSING_ORGANIZATION_ID');
    });

    it('POST /api/organizations/:orgId/search defaults to hybrid retrieval mode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgAId}/search`,
        headers: {
          authorization: `Bearer ${viewerAToken}`,
        },
        payload: {
          query: 'calculateTaxAmount',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.mode).toBe('hybrid');
      expect(data.chunks.length).toBeGreaterThan(0);
      expect(data.chunks[0].rrfScore).toBeDefined();
    });

    it('POST /api/documents/:id/search scopes retrieval to the specified document', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/documents/${docA2Id}/search`,
        headers: {
          authorization: `Bearer ${viewerAToken}`,
        },
        payload: {
          query: 'Kubernetes container cluster',
          mode: 'hybrid',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.chunks.length).toBeGreaterThan(0);
      for (const chunk of data.chunks) {
        expect(chunk.documentId).toBe(docA2Id);
      }
    });

    it('POST /api/search rejects invalid topK values (< 1 or > 50) with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search',
        headers: {
          authorization: `Bearer ${viewerAToken}`,
          'x-organization-id': orgAId,
        },
        payload: {
          query: 'test query',
          topK: 100, // Exceeds max 50
        },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
    });
  });
});
