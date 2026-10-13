import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { getPool, closePool } from '../src/index.js';
import {
  runMigrations,
  resetTestDatabase,
  getMigrationStatus,
} from '../src/migrator.js';
import { validateTestResetSafety } from '../src/safety.js';

// Dedicated test database URL: NEVER fall back to DATABASE_URL
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

// Pre-validate the test target before running any connections or tests
const validatedTarget = validateTestResetSafety(
  TEST_DATABASE_URL,
  process.env.DATABASE_URL
);

describe('PostgreSQL Schema, Constraints, and pgvector Integration', () => {
  let client: PoolClient;

  beforeAll(async () => {
    console.log(
      `[TEST SUITE] Confirmed dedicated test database target: ${validatedTarget.sanitized}`
    );

    // Fresh schema reset on verified dedicated test database
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    const pool = getPool(TEST_DATABASE_URL);
    try {
      client = await pool.connect();
    } catch (err) {
      throw new Error(
        `Failed to connect to verified test database (${validatedTarget.sanitized}): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Please ensure PostgreSQL with pgvector is running and the test database exists.'
      );
    }
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    await closePool();
  });

  describe('1. Migration Engine & Idempotency', () => {
    it('applies migrations in correct sequence and records them in schema_migrations', async () => {
      const res = await client.query<{ version: string; name: string }>(
        'SELECT version, name FROM schema_migrations ORDER BY version ASC'
      );
      expect(res.rows.length).toBe(3);
      expect(res.rows[0]?.version).toBe('001');
      expect(res.rows[0]?.name).toBe('enable_pgvector');
      expect(res.rows[1]?.version).toBe('002');
      expect(res.rows[1]?.name).toBe('create_initial_schema');
      expect(res.rows[2]?.version).toBe('003');
      expect(res.rows[2]?.name).toBe('create_revoked_tokens');
    });

    it('re-running migrations is completely idempotent (applies 0, skips all)', async () => {
      const result = await runMigrations(TEST_DATABASE_URL);
      expect(result.applied.length).toBe(0);
      expect(result.skipped.length).toBe(3);
    });

    it('reports migration status correctly', async () => {
      const status = await getMigrationStatus(TEST_DATABASE_URL);
      expect(status.length).toBe(3);
      expect(status.every((s) => s.applied)).toBe(true);
    });
  });

  describe('2. Extensions & Type Verification', () => {
    it('has pgvector extension enabled and functional', async () => {
      const res = await client.query<{ extname: string; extversion: string }>(
        "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'"
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0]?.extname).toBe('vector');
    });

    it('has all core domain and auth tables created', async () => {
      const res = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      const tables = new Set(res.rows.map((r) => r.table_name));

      const expected = [
        'users',
        'organizations',
        'organization_members',
        'documents',
        'document_versions',
        'chunks',
        'chat_sessions',
        'messages',
        'retrieval_runs',
        'retrieval_results',
        'feedback',
        'jobs',
        'revoked_tokens',
      ];

      for (const table of expected) {
        expect(tables.has(table), `Expected table ${table} to exist`).toBe(true);
      }
    });
  });

  describe('3. Multi-Tenancy & Integrity Constraints', () => {
    it('enforces unique user emails', async () => {
      await client.query(
        "INSERT INTO users (email, password_hash) VALUES ('test1@example.com', 'hash_1')"
      );

      await expect(
        client.query(
          "INSERT INTO users (email, password_hash) VALUES ('test1@example.com', 'hash_2')"
        )
      ).rejects.toThrow(/uq_users_email/);
    });

    it('enforces check constraint on user account status', async () => {
      await expect(
        client.query(
          "INSERT INTO users (email, password_hash, account_status) VALUES ('invalid@example.com', 'hash', 'banned')"
        )
      ).rejects.toThrow(/chk_users_account_status/);
    });

    it('enforces unique membership per (organization_id, user_id)', async () => {
      const userRes = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash) VALUES ('member@example.com', 'hash') RETURNING id"
      );
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Acme Corp', 'acme') RETURNING id"
      );

      const userId = userRes.rows[0]!.id;
      const orgId = orgRes.rows[0]!.id;

      await client.query(
        'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [orgId, userId, 'admin']
      );

      await expect(
        client.query(
          'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
          [orgId, userId, 'viewer']
        )
      ).rejects.toThrow(/uq_org_members_org_user/);
    });

    it('enforces valid organization member roles (admin, member, viewer)', async () => {
      const userRes = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash) VALUES ('badrole@example.com', 'hash') RETURNING id"
      );
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Beta Corp', 'beta') RETURNING id"
      );

      await expect(
        client.query(
          'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
          [orgRes.rows[0]!.id, userRes.rows[0]!.id, 'superuser']
        )
      ).rejects.toThrow(/chk_org_members_role/);
    });

    it('enforces unique document version numbering per document', async () => {
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Docs Corp', 'docs-corp') RETURNING id"
      );
      const orgId = orgRes.rows[0]!.id;

      const docRes = await client.query<{ id: string }>(
        'INSERT INTO documents (organization_id, name, source_type) VALUES ($1, $2, $3) RETURNING id',
        [orgId, 'architecture.md', 'markdown']
      );
      const docId = docRes.rows[0]!.id;

      await client.query(
        'INSERT INTO document_versions (document_id, version_number, content_hash) VALUES ($1, 1, $2)',
        [docId, 'hash_version_1']
      );

      await expect(
        client.query(
          'INSERT INTO document_versions (document_id, version_number, content_hash) VALUES ($1, 1, $2)',
          [docId, 'hash_version_duplicate']
        )
      ).rejects.toThrow(/uq_doc_versions_doc_version/);
    });

    it('enforces unique job idempotency keys per organization', async () => {
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Job Corp', 'jobs-corp') RETURNING id"
      );
      const orgId = orgRes.rows[0]!.id;

      await client.query(
        "INSERT INTO jobs (organization_id, type, idempotency_key) VALUES ($1, 'document_ingestion', 'job-key-123')",
        [orgId]
      );

      await expect(
        client.query(
          "INSERT INTO jobs (organization_id, type, idempotency_key) VALUES ($1, 'document_ingestion', 'job-key-123')",
          [orgId]
        )
      ).rejects.toThrow(/uq_jobs_org_idempotency/);
    });
  });

  describe('4. Foreign Key Cascades & Referential Integrity', () => {
    it('cascades document deletion to versions and chunks', async () => {
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Cascade Corp', 'cascade') RETURNING id"
      );
      const orgId = orgRes.rows[0]!.id;

      const docRes = await client.query<{ id: string }>(
        "INSERT INTO documents (organization_id, name, source_type) VALUES ($1, 'doc.pdf', 'pdf') RETURNING id",
        [orgId]
      );
      const docId = docRes.rows[0]!.id;

      const versionRes = await client.query<{ id: string }>(
        'INSERT INTO document_versions (document_id, version_number, content_hash) VALUES ($1, 1, $2) RETURNING id',
        [docId, 'hash_cascade_1']
      );
      const versionId = versionRes.rows[0]!.id;

      await client.query(
        'INSERT INTO chunks (document_version_id, chunk_index, content) VALUES ($1, 0, $2)',
        [versionId, 'Sample chunk content for cascade test']
      );

      // Verify records exist
      const beforeChunks = await client.query(
        'SELECT count(*) FROM chunks WHERE document_version_id = $1',
        [versionId]
      );
      expect(parseInt(beforeChunks.rows[0]!.count, 10)).toBe(1);

      // Delete parent document
      await client.query('DELETE FROM documents WHERE id = $1', [docId]);

      // Versions and Chunks should be cascade deleted
      const afterVersions = await client.query(
        'SELECT count(*) FROM document_versions WHERE id = $1',
        [versionId]
      );
      expect(parseInt(afterVersions.rows[0]!.count, 10)).toBe(0);

      const afterChunks = await client.query(
        'SELECT count(*) FROM chunks WHERE document_version_id = $1',
        [versionId]
      );
      expect(parseInt(afterChunks.rows[0]!.count, 10)).toBe(0);
    });

    it('sets created_by to NULL when user is deleted (ON DELETE SET NULL)', async () => {
      const userRes = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash) VALUES ('author@example.com', 'hash') RETURNING id"
      );
      const userId = userRes.rows[0]!.id;

      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Author Corp', 'author-corp') RETURNING id"
      );
      const orgId = orgRes.rows[0]!.id;

      const docRes = await client.query<{ id: string }>(
        'INSERT INTO documents (organization_id, created_by, name, source_type) VALUES ($1, $2, $3, $4) RETURNING id',
        [orgId, userId, 'authored_doc.md', 'markdown']
      );
      const docId = docRes.rows[0]!.id;

      // Delete user
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      const docCheck = await client.query<{ created_by: string | null }>(
        'SELECT created_by FROM documents WHERE id = $1',
        [docId]
      );
      expect(docCheck.rows[0]?.created_by).toBeNull();
    });

    it('cascades user deletion to revoked_tokens (ON DELETE CASCADE)', async () => {
      const userRes = await client.query<{ id: string }>(
        "INSERT INTO users (email, password_hash) VALUES ('tokendelete@example.com', 'hash') RETURNING id"
      );
      const userId = userRes.rows[0]!.id;

      await client.query(
        "INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES ('jti-test-123', $1, now() + interval '1 hour')",
        [userId]
      );

      const beforeCount = await client.query(
        "SELECT count(*) FROM revoked_tokens WHERE jti = 'jti-test-123'"
      );
      expect(parseInt(beforeCount.rows[0]!.count, 10)).toBe(1);

      // Delete user
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      const afterCount = await client.query(
        "SELECT count(*) FROM revoked_tokens WHERE jti = 'jti-test-123'"
      );
      expect(parseInt(afterCount.rows[0]!.count, 10)).toBe(0);
    });
  });

  describe('5. pgvector 1536-Dimensional Vector Search', () => {
    it('stores 1536-dimensional embeddings and performs cosine distance queries', async () => {
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('Vector Corp', 'vector-corp') RETURNING id"
      );
      const docRes = await client.query<{ id: string }>(
        'INSERT INTO documents (organization_id, name, source_type) VALUES ($1, $2, $3) RETURNING id',
        [orgRes.rows[0]!.id, 'vector_guide.md', 'markdown']
      );
      const verRes = await client.query<{ id: string }>(
        'INSERT INTO document_versions (document_id, version_number, content_hash) VALUES ($1, 1, $2) RETURNING id',
        [docRes.rows[0]!.id, 'hash_vector']
      );
      const versionId = verRes.rows[0]!.id;

      // Generate two distinct 1536-dimensional vectors
      const vectorA = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      const vectorB = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0));
      const vectorQuery = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 0.9 : 0.1));

      const strA = `[${vectorA.join(',')}]`;
      const strB = `[${vectorB.join(',')}]`;
      const strQ = `[${vectorQuery.join(',')}]`;

      await client.query(
        'INSERT INTO chunks (document_version_id, chunk_index, content, embedding) VALUES ($1, 0, $2, $3::vector)',
        [versionId, 'Chunk A: Close to query', strA]
      );

      await client.query(
        'INSERT INTO chunks (document_version_id, chunk_index, content, embedding) VALUES ($1, 1, $2, $3::vector)',
        [versionId, 'Chunk B: Far from query', strB]
      );

      // Perform cosine distance query using <=> operator
      const result = await client.query<{ chunk_index: number; distance: number }>(
        `SELECT chunk_index, (embedding <=> $1::vector) as distance
         FROM chunks
         WHERE document_version_id = $2
         ORDER BY embedding <=> $1::vector ASC`,
        [strQ, versionId]
      );

      expect(result.rows.length).toBe(2);
      // Chunk A should be closer to query than Chunk B
      expect(result.rows[0]!.chunk_index).toBe(0);
      expect(result.rows[1]!.chunk_index).toBe(1);
      expect(result.rows[0]!.distance).toBeLessThan(result.rows[1]!.distance);
    });
  });

  describe('6. PostgreSQL Full-Text Search (tsvector)', () => {
    it('automatically generates tsvector and matches lexical queries', async () => {
      const orgRes = await client.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('FTS Corp', 'fts-corp') RETURNING id"
      );
      const docRes = await client.query<{ id: string }>(
        'INSERT INTO documents (organization_id, name, source_type) VALUES ($1, $2, $3) RETURNING id',
        [orgRes.rows[0]!.id, 'lexical.md', 'markdown']
      );
      const verRes = await client.query<{ id: string }>(
        'INSERT INTO document_versions (document_id, version_number, content_hash) VALUES ($1, 1, $2) RETURNING id',
        [docRes.rows[0]!.id, 'hash_fts']
      );
      const versionId = verRes.rows[0]!.id;

      await client.query(
        'INSERT INTO chunks (document_version_id, chunk_index, content) VALUES ($1, 0, $2)',
        [
          versionId,
          'DevDocs AI integrates Fastify REST endpoints with pgvector embeddings for hybrid retrieval.',
        ]
      );

      await client.query(
        'INSERT INTO chunks (document_version_id, chunk_index, content) VALUES ($1, 1, $2)',
        [
          versionId,
          'Standard database relational tables store organizations and user memberships.',
        ]
      );

      // Verify search_vector is automatically computed
      const checkVector = await client.query<{ search_vector: string }>(
        'SELECT search_vector FROM chunks WHERE document_version_id = $1 AND chunk_index = 0',
        [versionId]
      );
      expect(checkVector.rows[0]?.search_vector).toBeTruthy();
      expect(checkVector.rows[0]?.search_vector).toContain('fastifi');

      // Query full text search using @@ to_tsquery
      const searchRes = await client.query<{ chunk_index: number }>(
        `SELECT chunk_index FROM chunks
         WHERE document_version_id = $1 AND search_vector @@ to_tsquery('english', 'Fastify & pgvector')`,
        [versionId]
      );

      expect(searchRes.rows.length).toBe(1);
      expect(searchRes.rows[0]?.chunk_index).toBe(0);
    });
  });
});
