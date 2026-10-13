# DevDocs AI — Project Status

Last Updated: Phase 06 Completion Checkpoint

---

## 1. Phase Tracker

| Phase | Description | Status | Evidence / Notes |
| :--- | :--- | :--- | :--- |
| **01** | **Architecture and Bootstrap** | **COMPLETED** | Monorepo, Fastify 5 API, React 18 UI, Zod validation, Pino logging, tests passing |
| **02** | **Database Schema & Migrations** | **COMPLETED** | PostgreSQL + pgvector 0.8+, 12 domain tables, sequential migrations, 15 integration tests |
| **03** | **Auth, Organizations & RBAC** | **COMPLETED** | Bcrypt hashing, JWT + jti denylist revocation, multi-tenant RBAC (Admin/Member/Viewer), 100 monorepo tests passing |
| **04** | **Document Upload & Parsing** | **COMPLETED** | Multipart upload, PDF/Markdown/TXT parsers, magic bytes, path traversal sanitization, SHA-256 deduplication, 135 monorepo tests passing |
| **05** | **Chunking, Embeddings & Ingestion** | **COMPLETED** | Structure-aware normalizer & chunker, native fetch OpenAI embeddings (1536d), pgvector transactional storage, 155 monorepo tests passing |
| **06** | **Vector Search & Base RAG** | **COMPLETED** | pgvector cosine similarity retrieval, HNSW indexing, bounded context Groq LLM RAG, 186 monorepo tests passing |
| 07 | Hybrid Retrieval & Rank Fusion | PENDING | Scheduled for Instruction 07 |
| 08 | Grounded Chat & Citations | PENDING | Scheduled for Instruction 08 |
| 09 | Document Versions & Reindex | PENDING | Scheduled for Instruction 09 |
| 10 | Async Worker & Retries | PENDING | Scheduled for Instruction 10 |
| 11 | GitHub Codebase Ingestion | PENDING | Scheduled for Instruction 11 |
| 12 | Frontend Workspace & Documents | PENDING | Scheduled for Instruction 12 |
| 13 | Frontend Search, Chat & Citations | PENDING | Scheduled for Instruction 13 |
| 14 | Feedback & Admin Analytics | PENDING | Scheduled for Instruction 14 |
| 15 | Retrieval Evaluation Benchmark | PENDING | Scheduled for Instruction 15 |
| 16 | Observability & Diagnostics | PENDING | Scheduled for Instruction 16 |
| 17 | Testing & Security Hardening | PENDING | Scheduled for Instruction 17 |
| 18 | Docker & CI/CD Deployment | PENDING | Scheduled for Instruction 18 |
| 19 | Acceptance & Interview Readiness | PENDING | Scheduled for Instruction 19 |

---

## 2. Phase 02 Verification & Evidence

### Criteria Verified
- [x] Sequential SQL migrations: `001_enable_pgvector.sql` and `002_create_initial_schema.sql`.
- [x] Version tracking via `schema_migrations` table with transactional execution and rollback safety.
- [x] pgvector extension enabled (`vector(1536)` for OpenAI `text-embedding-3-small`).
- [x] HNSW cosine vector index on `chunks.embedding` (`USING hnsw (embedding vector_cosine_ops)`).
- [x] Stored generated column for full-text search (`search_vector tsvector`) with GIN indexing.
- [x] All 12 core tables created with UUID primary keys and timestamps:
  - `users`, `organizations`, `organization_members`
  - `documents`, `document_versions`, `chunks`
  - `chat_sessions`, `messages`, `retrieval_runs`, `retrieval_results`
  - `feedback`, `jobs`
- [x] Multi-tenancy integrity constraints:
  - Unique membership per `(organization_id, user_id)`
  - Unique version numbering per `(document_id, version_number)`
  - Unique job idempotency per `(organization_id, idempotency_key)`
- [x] Role check constraints: `admin`, `member`, `viewer`.
- [x] Automated CLI commands: `npm run db:status`, `npm run db:migrate`, and guarded `ALLOW_DB_RESET=true npm run db:reset`.
- [x] Hardened reset safeguards and test isolation (`packages/db/src/safety.ts`):
  - `db:reset` rejects execution if `NODE_ENV` is unset or not `'development'`, or if `ALLOW_DB_RESET !== 'true'`.
  - Production, staging, and remote database targets rejected even if forced.
  - Dedicated test database isolation requires `_test` suffix and strictly refuses to run against application `DATABASE_URL`.
  - Module-based resolution reliably loads root `.env` without requiring shell exports.
- [x] 41 database tests (26 safety/guard tests + 15 schema/pgvector integration tests) in `@devdocs/db` passing cleanly.
- [x] 58 total monorepo tests passing with zero failures.
- [x] Zero regressions in existing Phase 1 checks: typecheck, lint, build, and tests passing across all packages.

---

## 3. Phase 03 Verification & Evidence

### Criteria Verified
- [x] User Registration & Login:
  - Password hashing via bcrypt (`bcryptjs`) with 10 salt rounds. Plaintext passwords are never stored.
  - Plaintext passwords and `password_hash` are never returned in API responses or leaked in logs.
  - Case-insensitive email normalization and validation via Zod schemas.
  - Generic 401 `INVALID_CREDENTIALS` error prevents account existence enumeration.
- [x] Token Lifecycle & Revocation:
  - Expiring JWT access tokens with cryptographically random `jti` (UUID) claims and configurable lifetime.
  - Strict secret validation (`JWT_SECRET` minimum 32 characters in production; non-default values enforced).
  - Explicit logout token revocation via PostgreSQL `revoked_tokens` denylist table (`003_create_revoked_tokens.sql`).
  - Cascading deletion (`ON DELETE CASCADE`) ensures cleanup when user accounts are removed.
  - Immediate rejection (`401 TOKEN_REVOKED`) of logged-out tokens on subsequent requests.
- [x] Organization Workspace & Membership:
  - Atomic organization creation within transaction; creator automatically assigned `Admin` role.
  - URL-safe slug generation with collision resistance.
  - Listing user organizations via `GET /api/organizations` and `GET /api/auth/me`.
  - Member management (`addOrganizationMember`, `updateMemberRole`, `removeOrganizationMember`).
  - Sole administrator protection: demoting or removing the last admin in an organization is strictly blocked (`CANNOT_DEMOTE_LAST_ADMIN`, `CANNOT_REMOVE_LAST_ADMIN`).
- [x] Server-Side RBAC Enforcement:
  - Role hierarchy: `Admin` > `Member` > `Viewer`.
  - PreHandler hook `requireOrgRole(role)` enforces minimum role on every protected route.
  - Verified across real resource operations:
    - `Admin`: Can create/upload documents, read documents, delete documents, and manage members.
    - `Member`: Can create/upload documents and read documents; rejected from deleting documents (403 `FORBIDDEN`) and managing members (403 `FORBIDDEN`).
    - `Viewer`: Can read documents and view member list; rejected from uploading documents (403 `FORBIDDEN`), deleting documents (403 `FORBIDDEN`), and managing members (403 `FORBIDDEN`).
- [x] Multi-Tenant Isolation & Non-Disclosure:
  - Database membership verified on all organization routes; client-supplied `organization_id` header or body parameters cannot bypass authorization.
  - Foreign organization access attempts return 404 `ORGANIZATION_NOT_FOUND` / `DOCUMENT_NOT_FOUND` to prevent attackers from discovering whether external tenants or resources exist.

---

## 4. Phase 04 Verification & Evidence

### Criteria Verified
- [x] Multi-format File Upload & Validation (`POST /api/documents` and `POST /api/organizations/:orgId/documents`):
  - Streaming multipart/form-data ingestion via `@fastify/multipart` bounded by `MAX_FILE_SIZE_BYTES` (10MB default).
  - Strict file extension and MIME type allowlist (`.pdf` -> `application/pdf`, `.md`/`.markdown` -> `text/markdown`, `.txt` -> `text/plain`).
  - Filename sanitization protecting against directory traversal (`../`, `..\`, leading `/`, null bytes) across POSIX and Windows platforms.
  - Deep content verification: PDF `%PDF-` magic byte inspection and null-byte binary probing for text/markdown formats.
  - Empty files (`0` bytes) and oversized payloads (> 10MB) rejected with HTTP 400.
- [x] Content Hash Deduplication:
  - Deterministic SHA-256 hash calculated over raw file bytes.
  - Duplicate file uploads within the same tenant rejected with HTTP 409 `DUPLICATE_DOCUMENT` containing the existing document ID and status, preventing redundant ingestion and embedding overhead.
  - Cross-tenant identical files allowed and isolated per organization workspace.
- [x] Domain-Specific Parsers:
  - **PDF Parser**: Page-by-page extraction via `unpdf` with page counts and character counts. Scanned / image-only PDFs with zero extractable text are safely marked `failed` with an actionable `PROCESSING_ERROR` requiring OCR.
  - **Markdown Parser**: Hierarchical AST extraction preserving heading levels (`h1`-`h6`), start/end line numbers, and literal fenced code blocks (` ``` `).
  - **Plain Text Parser**: Preserves formatting, line counts, character counts, and word counts.
- [x] Document Lifecycle & Metadata Persistence:
  - Document status transitions: `queued` -> `processing` -> `ready` (or `failed` upon unextractable content), matching database CHECK constraints.
  - Extracted raw text, page structures, hierarchical sections, and metrics persisted to PostgreSQL `document_versions.source_details` JSONB.
  - Clean in-memory garbage collection; zero orphaned temporary files on disk.
- [x] Tenant-Scoped Document Retrieval & Operations:
  - `GET /api/documents`: Paginated, sorted list of documents for authorized members, filtered by tenant `organizationId`.
  - `GET /api/documents/:id`: Full document details and latest version summary. Cross-tenant lookups return HTTP 404.
  - `DELETE /api/documents/:id`: Admin-only deletion. Cascades through `document_versions` and associated records.
- [x] Server-Side RBAC:
  - `Admin`: Can upload, list, view, and delete documents.
  - `Member`: Can upload, list, and view documents; rejected from deletion (403 `FORBIDDEN`).
  - `Viewer`: Can list and view documents; rejected from upload and deletion (403 `FORBIDDEN`).
- [x] Comprehensive Automated Tests:
  - 15 parser and validation unit tests (`apps/api/tests/parsers.test.ts`).
  - 20 document lifecycle, upload, deduplication, tenant isolation, and RBAC integration tests (`apps/api/tests/documents.test.ts`).
  - **135 total monorepo tests passing** with zero failures across all packages.
- [x] Zero dependency vulnerabilities (`npm audit` reports 0 vulnerabilities).
- [x] Full monorepo typecheck, build, and lint passing cleanly with exit code 0.

---

## 5. Phase 05 Verification & Evidence

### Criteria Verified
- [x] Structure-Preserving Normalizer & Cleaner:
  - Normalizes line breaks to LF (`\n`), strips dangerous ASCII control characters while preserving `\t` and `\n`.
  - Standardizes typographical quotes and dashes.
  - Cleans trailing whitespace per line while preserving indentation for code blocks and lists.
  - Compresses excessive blank lines while preserving paragraph separations.
  - Throws typed `IngestionError` (stage `normalization`) on empty or whitespace-only inputs.
- [x] Structure-Aware Chunking:
  - **Markdown**: Heading-aware section hierarchy (`H1` through `H6`), tracking section title, heading level, line start/end numbers, and preserving code blocks intact.
  - **PDF**: Preserves page boundaries and numbers (`page_number`), generating sub-chunks with configured overlap when page length exceeds chunk size.
  - **Plain Text**: Slices on paragraph breaks (`\n\n`), falling back to sentence and word boundaries for oversized blocks.
  - Configurable defaults: 800 character chunk size, 120 character overlap, 50 minimum character size.
  - Deterministic 0-based indexing (`chunk_index = 0, 1, 2, ...`). Identical inputs produce strictly identical chunks.
- [x] Embedding Provider Abstraction & Adapters:
  - `EmbeddingProvider` interface with `model`, `dimensions`, and `embedChunks(texts: string[])`.
  - `MockEmbeddingProvider`: Produces deterministic 1536-dimensional L2-normalized unit vectors seeded by SHA-256 content hashes; supports error and dimension simulation for tests.
  - `OpenAIEmbeddingProvider`: Built using native Node 22 `fetch` and `AbortSignal.timeout` with zero additional npm dependencies.
    - Default model `text-embedding-3-small`, standard output 1536 dimensions.
    - Input batching according to configured batch size (default: 100).
    - Strict validation: exact dimensionality (1536) and finite numeric values (`Number.isFinite`).
    - Redacts sensitive secrets (`sk-...`, Bearer tokens) from error messages before propagation.
    - Opt-in live smoke test clearly labeled and skipped when live API key is unset.
- [x] Transactional pgvector Persistence:
  - Chunks, metadata, and 1536-dimensional vectors persisted to PostgreSQL `chunks` table inside `withTransaction`.
  - Parameterized vector format `[x,y,...]::vector`.
  - Generated tsvector `search_vector` column populated automatically by PostgreSQL.
  - Idempotent re-ingestion: existing chunks for the target version are safely removed and replaced within the transaction.
- [x] Lifecycle & Finalization:
  - Successful ingestion transitions document version to `ready`, updating `source_details` with `chunkCount`, `totalCharacters`, `totalEstimatedTokens`, `embeddingModel`, `embeddingDimensions`, and `ingestedAt`.
  - Ingestion failure transitions document version to `failed`, recording `errorStage` and sanitized error message. Partial chunks are never committed.
- [x] Transport-Independent Pipeline & API Endpoints:
  - Purely functional `ingestDocumentVersion` service callable from upload handler or async workers.
  - `GET /api/documents/:id/chunks`: Paginated chunk listing with `page`, `limit`, `total`, `totalPages`, and tenant isolation.
  - `POST /api/documents/:id/ingest`: Re-ingestion endpoint with RBAC (Admin & Member allowed, Viewer rejected with 403).
  - Auto-ingestion triggered on document upload.
- [x] Comprehensive Automated Tests:
  - 12 normalization, chunking, and token estimation tests (`apps/api/tests/chunking.test.ts`).
  - 14 embedding provider, adapter boundary, validation, and error redaction tests (`apps/api/tests/embeddings.test.ts`).
  - 8 end-to-end ingestion, pgvector storage, cosine similarity queries, chunk pagination, and failure rollback tests (`apps/api/tests/ingestion.test.ts`).
  - **154 total monorepo tests passing** with zero failures across all packages.
- [x] Zero dependency vulnerabilities (`npm audit` reports 0 vulnerabilities).
- [x] Full monorepo typecheck, build, and lint passing cleanly with exit code 0.

---

## 6. Phase 06 Verification & Evidence

### Criteria Verified
- [x] Semantic Vector Retrieval over pgvector:
  - Cosine distance (`<=>`) metric over 1536-dimensional chunk embeddings.
  - Cosine similarity computed as `1 - distance`.
  - HNSW vector index (`idx_chunks_embedding`) utilized for efficient approximate nearest neighbor retrieval.
  - Strict tenant isolation: scoped strictly to authenticated organization (`d.organization_id = $2`), ready versions (`dv.status = 'ready'`), and current versions (`dv.id = d.current_version_id`). Zero cross-tenant leakage.
  - Configurable `topK` with strict bounds (min 1, max 20, default 5).
  - Document-scoped filtering via optional `documentId` parameter.
  - Empty corpus and no-match queries return empty candidate sets safely without errors.
  - Query normalization: strips ASCII control characters, collapses whitespace, trims boundaries.
- [x] Observability & Latency Separation:
  - Granular latency breakdowns separating `embeddingMs`, `retrievalMs`, and `generationMs` in internal result metadata and API responses.
- [x] Prompt Construction & Anti-Prompt-Injection Security:
  - Formats retrieved candidates into structured, delimited reference blocks (`[Source N: "Doc" | Section | Page | File | Lines]`).
  - Enforces deterministic context character budget (`maxContextChars`, default 12,000 characters). Lower-ranked chunks exceeding budget are omitted or truncated.
  - System prompt establishes explicit instruction hierarchy: reference documentation is untrusted data; source contents cannot override system rules; generation must rely strictly on retrieved facts; outside knowledge is forbidden; and model states clear insufficient-evidence message when facts are absent.
- [x] Groq LLM Adapter & Testing Fallback:
  - `GroqProvider` implements Groq Chat Completions API using native Node 22 `fetch` (default model `llama-3.3-70b-versatile`).
  - 30-second timeout handling with `AbortController` (504 `REQUEST_TIMEOUT`).
  - Redaction of `gsk_...` API keys, `sk-...` API keys, and `Bearer` tokens from all error messages.
  - `MockLLMProvider`: Deterministic grounded generation synthesizing answers from prompt context, enabling 100% offline testing without Groq credentials.
  - Zero-candidate early return: if retrieval returns no chunks, `queryRAG` returns an insufficient-evidence response immediately without invoking the LLM provider.
- [x] API Endpoints:
  - `POST /api/organizations/:orgId/search` & `POST /api/organizations/:orgId/retrieval/vector`: Semantic search with RBAC (Viewer, Member, Admin authorized; non-member rejected with 404).
  - `POST /api/organizations/:orgId/query` & `POST /api/organizations/:orgId/rag/query`: Grounded RAG query endpoint with RBAC.
  - `POST /api/documents/:id/search` & `POST /api/documents/:id/query`: Document-scoped semantic search and RAG answering.
- [x] Comprehensive Automated Tests:
  - 14 vector retrieval, ranking, tenant isolation, and status filtering tests (`apps/api/tests/vectorSearch.test.ts`).
  - 17 prompt construction, context budgeting, Groq adapter error handling, and API route tests (`apps/api/tests/rag.test.ts`).
  - **185 total monorepo tests passing** with 1 opt-in live test skipped and 0 failures.
- [x] Zero dependency vulnerabilities (`npm audit` reports 0 vulnerabilities).
- [x] Full monorepo typecheck, build, and lint passing cleanly with exit code 0.

---

## 7. Known Gaps & Deferred Items

The following items are intentionally deferred to subsequent phases:
1. **Hybrid Retrieval & Rank Fusion**: PostgreSQL full-text search (tsvector/GIN) combined with vector search via Reciprocal Rank Fusion (RRF) scheduled for **Phase 07**.
2. **Grounded Chat & Citations**: Multi-turn chat sessions, citation validation against source chunk IDs, and source viewer scheduled for **Phase 08**.
3. **Document Versions & Reindex**: Multi-version comparison and branch diffing scheduled for **Phase 09**.
4. **Async Worker & Queue**: BullMQ and Redis deferred to **Phase 10**.

---

## 8. Next Step

Vector similarity search, HNSW indexing, bounded context prompt construction, Groq LLM generation, and Fastify search/query API endpoints are fully implemented and verified.
**Status**: Ready for **Instruction 07 — Hybrid Retrieval and Rank Fusion**.
