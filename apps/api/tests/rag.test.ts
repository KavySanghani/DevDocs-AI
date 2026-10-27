import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import type { RetrievedChunk } from '@devdocs/shared';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import { ingestDocumentVersion } from '../src/services/ingestion/ingestionService.js';
import type { EmbeddingProvider } from '../src/services/ingestion/types.js';
import { buildRAGPrompt } from '../src/services/generation/promptBuilder.js';
import { GroqProvider, MockLLMProvider } from '../src/services/generation/groqProvider.js';
import { queryRAG } from '../src/services/generation/ragService.js';
import { LLMError } from '../src/services/generation/types.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

describe('Phase 6: Grounded RAG Generation & API Routes', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_rag_suite_32_characters!';

  let orgAId: string;
  let orgBId: string;
  let adminAToken: string;
  let viewerAToken: string;
  let nonMemberToken: string;

  let docAId: string;
  let docAVersionId: string;

  class SemanticMockEmbeddingProvider implements EmbeddingProvider {
    readonly model = 'semantic-rag-fixture-model';
    readonly dimensions = 1536;

    private readonly topicDimensions: Record<string, number> = {
      docker: 0,
      compose: 1,
      container: 2,
      kubernetes: 3,
      architecture: 10,
    };

    async embedChunks(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vec = new Array(1536).fill(0);
        const lower = text.toLowerCase();
        let matched = false;

        for (const [topic, dim] of Object.entries(this.topicDimensions)) {
          if (lower.includes(topic)) {
            vec[dim] = 1.0;
            matched = true;
          }
        }

        if (!matched) {
          vec[100] = 0.5;
        }

        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vec.map((v) => Number((v / norm).toFixed(7)));
      });
    }
  }

  const mockEmbeddingProvider = new SemanticMockEmbeddingProvider();

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4008',
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

    const adminA = await register('rag_admin_a@tenant.com');
    adminAToken = adminA.token;

    const viewerA = await register('rag_viewer_a@tenant.com');
    viewerAToken = viewerA.token;

    const nonMember = await register('rag_non_member@other.com');
    nonMemberToken = nonMember.token;

    // Create Org A
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'DevOps Org' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add viewerA to Org A
    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'rag_viewer_a@tenant.com', role: 'viewer' },
    });

    // Create Org B
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${nonMemberToken}` },
      payload: { name: 'Isolated Org B' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;

    // Create and ingest doc in Org A
    const docRes = await query<{ id: string }>(
      `INSERT INTO documents (organization_id, name, source_type)
       VALUES ($1, 'Docker Architecture Guide', 'markdown')
       RETURNING id`,
      [orgAId]
    );
    docAId = docRes.rows[0]!.id;

    const sourceDetails = {
      rawText: `# Docker and Container Deployment\n\nDocker simplifies application deployment through isolated container environments. DevDocs AI uses Docker Compose to orchestrate Fastify, PostgreSQL with pgvector, and web services.\n\n## Container Networking and Volumes\n\nPersistent data is stored in PostgreSQL named volumes. Container networking allows Fastify to communicate with PostgreSQL over port 5432 internally.`,
      characterCount: 400,
      originalFilename: 'Docker.md',
      mimeType: 'text/markdown',
    };

    const verRes = await query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, content_hash, source_details, status)
       VALUES ($1, 1, 'docker_hash', $2, 'processing')
       RETURNING id`,
      [docAId, JSON.stringify(sourceDetails)]
    );
    docAVersionId = verRes.rows[0]!.id;

    await query(
      `UPDATE documents SET current_version_id = $1 WHERE id = $2`,
      [docAVersionId, docAId]
    );

    await ingestDocumentVersion({
      documentId: docAId,
      documentVersionId: docAVersionId,
      organizationId: orgAId,
      provider: mockEmbeddingProvider,
    });
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. Prompt Construction & Context Budgeting', () => {
    it('formats candidate chunks with clear source attribution and anti-injection instructions', () => {
      const sampleChunks: RetrievedChunk[] = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          documentId: '22222222-2222-2222-2222-222222222222',
          documentName: 'System Architecture',
          documentVersionId: '33333333-3333-3333-3333-333333333333',
          chunkIndex: 0,
          content: 'DevDocs AI uses PostgreSQL with pgvector for embeddings.',
          characterCount: 56,
          pageNumber: 1,
          sectionTitle: 'Storage Layer',
          filePath: 'docs/architecture.md',
          lineStart: 10,
          lineEnd: 25,
          similarityScore: 0.95,
          distance: 0.05,
          rank: 1,
        },
      ];

      const built = buildRAGPrompt('How is storage implemented?', sampleChunks, 10000);

      expect(built.systemPrompt).toContain('CRITICAL SECURITY AND GROUNDING INSTRUCTIONS');
      expect(built.systemPrompt).toContain('UNTRUSTED REFERENCE DATA');
      expect(built.userPrompt).toContain('[Source 1: "System Architecture" | Section: "Storage Layer" | Page: 1 | File: docs/architecture.md | Lines: 10-25]');
      expect(built.userPrompt).toContain('DevDocs AI uses PostgreSQL with pgvector for embeddings.');
      expect(built.includedChunks).toHaveLength(1);
      expect(built.totalContextChars).toBeGreaterThan(0);
    });

    it('enforces context character budget by dropping lower-ranked chunks when limit exceeded', () => {
      const makeChunk = (idx: number, size: number): RetrievedChunk => ({
        id: `chunk-id-${idx}`,
        documentId: 'doc-id',
        documentName: `Doc ${idx}`,
        documentVersionId: 'ver-id',
        chunkIndex: idx,
        content: 'X'.repeat(size),
        characterCount: size,
        similarityScore: 0.9 - idx * 0.1,
        distance: 0.1 + idx * 0.1,
        rank: idx + 1,
      });

      const chunks = [
        makeChunk(0, 500),
        makeChunk(1, 500),
        makeChunk(2, 500),
      ];

      // Set budget of 700 chars (only first chunk plus header will fit)
      const built = buildRAGPrompt('Test query', chunks, 700);

      expect(built.includedChunks).toHaveLength(1);
      expect(built.includedChunks[0]!.id).toBe('chunk-id-0');
      expect(built.totalContextChars).toBeLessThanOrEqual(700);
    });

    it('handles empty chunks array gracefully without throwing', () => {
      const built = buildRAGPrompt('Empty test query', [], 5000);
      expect(built.includedChunks).toHaveLength(0);
      expect(built.totalContextChars).toBe(0);
      expect(built.userPrompt).toContain('Empty test query');
    });
  });

  describe('2. Provider Error Handling & Secret Redaction', () => {
    it('redacts Groq and OpenAI API keys from error messages', () => {
      const provider = new GroqProvider({
        apiKey: 'gsk_test1234567890abcdefghijklmnopqrstuvwxyz',
      });

      // Test private sanitizer via error simulation
      const rawError = 'Invalid authorization token: gsk_test1234567890abcdefghijklmnopqrstuvwxyz or Bearer secret_12345';
      const sanitized = (provider as unknown as { sanitizeErrorMessage: (msg: string) => string }).sanitizeErrorMessage(rawError);

      expect(sanitized).not.toContain('gsk_test1234567890');
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).toContain('Bearer [REDACTED]');
    });

    it('aborts Groq requests upon timeout and returns 504 REQUEST_TIMEOUT', async () => {
      const provider = new GroqProvider({
        apiKey: 'gsk_test1234567890abcdefghijklmnopqrstuvwxyz',
        timeoutMs: 1, // 1ms timeout guarantees abort
        baseUrl: 'http://127.0.0.1:9999', // dummy endpoint
      });

      await expect(
        provider.generate('test prompt', 'test system')
      ).rejects.toThrow(LLMError);

      try {
        await provider.generate('test prompt', 'test system');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMError);
        expect((err as LLMError).code).toBe('REQUEST_TIMEOUT');
        expect((err as LLMError).statusCode).toBe(504);
      }
    });

    it('MockLLMProvider generates deterministic grounded responses from prompt reference', async () => {
      const mockLLM = new MockLLMProvider();
      const prompt = `REFERENCE DOCUMENTATION:\n==================================================\n[Source 1: "Guide"]\nDocker Compose orchestrates Fastify and PostgreSQL services.\n==================================================\nQUESTION:\nWhat does Compose do?`;

      const result = await mockLLM.generate(prompt);
      expect(result.content).toContain('Docker Compose orchestrates Fastify and PostgreSQL services.');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('3. End-to-End queryRAG Workflow', () => {
    it('retrieves relevant chunks and generates grounded answer for Org A', async () => {
      const mockLLM = new MockLLMProvider();

      const result = await queryRAG(
        {
          organizationId: orgAId,
          query: 'How does Docker deploy containers and databases?',
          topK: 5,
        },
        {
          embeddingProvider: mockEmbeddingProvider,
          llmProvider: mockLLM,
        }
      );

      expect(result.query).toBe('How does Docker deploy containers and databases?');
      expect(result.answer).toContain('Docker');
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.contextChunksCount).toBe(result.chunks.length);
      expect(result.insufficientEvidence).toBe(false);

      // Verify latency breakdown
      expect(result.latency.embeddingMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.retrievalMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.generationMs).toBeGreaterThanOrEqual(0);
      expect(result.latency.totalMs).toBeGreaterThanOrEqual(
        result.latency.embeddingMs + result.latency.retrievalMs + (result.latency.generationMs ?? 0)
      );

      // Verify source attribution retains actual document chunks for citations
      const firstChunk = result.chunks[0]!;
      expect(firstChunk.documentId).toBe(docAId);
      expect(firstChunk.documentName).toBe('Docker Architecture Guide');
    });

    it('returns clean insufficient-evidence response without calling LLM when no chunks match', async () => {
      const spyLLM = new MockLLMProvider();
      const generateSpy = vi.spyOn(spyLLM, 'generate');

      // Query Org B (which has 0 documents indexed)
      const result = await queryRAG(
        {
          organizationId: orgBId,
          query: 'How does Docker deploy containers?',
          topK: 5,
        },
        {
          embeddingProvider: mockEmbeddingProvider,
          llmProvider: spyLLM,
        }
      );

      expect(result.chunks).toHaveLength(0);
      expect(result.contextChunksCount).toBe(0);
      expect(result.insufficientEvidence).toBe(true);
      expect(result.answer).toContain('no relevant documentation was found in this workspace');
      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  describe('4. Fastify HTTP Endpoints (Vector Search & RAG Query)', () => {
    describe('POST /api/organizations/:orgId/search', () => {
      it('allows viewer to perform semantic search in their organization (200)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgAId}/search`,
          headers: { authorization: `Bearer ${viewerAToken}` },
          payload: {
            query: 'Docker container deployment',
            topK: 3,
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.query).toBe('Docker container deployment');
        expect(Array.isArray(body.chunks)).toBe(true);
        expect(body.totalCandidates).toBeGreaterThan(0);
        expect(body.latency).toBeDefined();
        expect(body.latency.embeddingMs).toBeGreaterThanOrEqual(0);
        expect(body.latency.retrievalMs).toBeGreaterThanOrEqual(0);
      });

      it('rejects unauthenticated requests with 401', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgAId}/search`,
          payload: { query: 'Docker container deployment' },
        });

        expect(res.statusCode).toBe(401);
      });

      it('rejects non-members of the organization with 404 (preventing org enumeration)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgAId}/search`,
          headers: { authorization: `Bearer ${nonMemberToken}` },
          payload: { query: 'Docker container deployment' },
        });

        expect(res.statusCode).toBe(404);
      });

      it('rejects empty query with 400 validation error', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgAId}/search`,
          headers: { authorization: `Bearer ${viewerAToken}` },
          payload: { query: '   ' },
        });

        expect(res.statusCode).toBe(400);
      });
    });

    describe('POST /api/organizations/:orgId/query', () => {
      it('allows viewer to execute end-to-end grounded RAG query (200)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgAId}/query`,
          headers: { authorization: `Bearer ${viewerAToken}` },
          payload: {
            query: 'How does Docker configure container networking?',
            topK: 3,
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.query).toBe('How does Docker configure container networking?');
        expect(body.answer).toBeDefined();
        expect(typeof body.answer).toBe('string');
        expect(Array.isArray(body.chunks)).toBe(true);
        expect(body.latency).toBeDefined();
        expect(body.latency.totalMs).toBeGreaterThanOrEqual(0);
      });

      it('supports /:orgId/rag/query alias route', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/organizations/${orgAId}/rag/query`,
          headers: { authorization: `Bearer ${viewerAToken}` },
          payload: { query: 'Docker container networking' },
        });

        expect(res.statusCode).toBe(200);
      });
    });

    describe('POST /api/documents/:id/search and /query', () => {
      it('allows document-scoped vector search', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/documents/${docAId}/search`,
          headers: { authorization: `Bearer ${viewerAToken}` },
          payload: { query: 'container networking' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.chunks.length).toBeGreaterThan(0);
        expect(body.chunks[0].documentId).toBe(docAId);
      });

      it('allows document-scoped RAG query', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/documents/${docAId}/query`,
          headers: { authorization: `Bearer ${viewerAToken}` },
          payload: { query: 'container networking' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.answer).toBeDefined();
      });

      it('returns 404 when querying document with non-member token', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/documents/${docAId}/search`,
          headers: { authorization: `Bearer ${nonMemberToken}` },
          payload: { query: 'container networking' },
        });

        expect(res.statusCode).toBe(404);
      });
    });
  });
});
