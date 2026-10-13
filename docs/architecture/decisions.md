# DevDocs AI — Architecture Decisions

This document records the architectural decisions, trade-offs, and rationale adopted for the DevDocs AI platform.

---

## ADR-001: Monorepo Architecture with npm Workspaces

- **Status**: Accepted
- **Context**: DevDocs AI consists of a REST API (`apps/api`), a React web interface (`apps/web`), future background ingestion workers (`apps/worker`), database migrations (`db/migrations`), and shared domain contracts (`packages/shared`).
- **Decision**: Use standard npm workspaces native to Node.js v20+ / npm v10+.
- **Rationale**:
  - Avoids third-party monorepo orchestrator bloat (e.g. Lerna, Nx, Turborepo) during early development phases.
  - Zero proprietary dependencies; reproducible across standard CI/CD and developer environments.
  - Enables clean code sharing through `@devdocs/shared`.
- **Consequences**: Monorepo scripts rely on standard npm workspace flags (`-w`, `--workspaces`).

---

## ADR-002: Fastify + TypeScript for the REST API

- **Status**: Accepted
- **Context**: The backend requires high throughput for search queries, streaming chat responses, structured logging, schema validation, and plugin-based lifecycle hooks.
- **Decision**: Adopt Fastify 5 with TypeScript.
- **Rationale**:
  - Significantly lower overhead and higher request throughput compared to Express.
  - Built-in integration with Pino for low-overhead structured JSON logging and sensitive field redaction.
  - Native encapsulation hierarchy and plugin model for cleanly isolating auth, routes, and error handling.
  - First-class testing via `app.inject()` without requiring physical network socket allocation.
- **Consequences**: Fastify-specific plugin patterns are used rather than Express middleware conventions.

---

## ADR-003: React 18 + Vite for Frontend Application

- **Status**: Accepted
- **Context**: The UI requires rapid interactive development, fast build bundling, and modular component isolation for document browsing, search, and citation inspection.
- **Decision**: Use React 18 with Vite and TypeScript.
- **Rationale**:
  - Instantaneous HMR and ES module dev server.
  - Standard, maintainable build toolchain producing static artifacts for deployment to CDNs or Nginx reverse proxies.
  - Pure Single Page Application (SPA) aligns cleanly with Fastify REST/SSE backend without Next.js server-side complexity.

---

## ADR-004: Strict TypeScript Baseline

- **Status**: Accepted
- **Context**: Technical interview standards and production reliability require robust type safety across domain logic, schema validation, and API contracts.
- **Decision**: Enforce strict TypeScript compiler flags across all workspace packages:
  - `strict: true`
  - `noImplicitAny: true`
  - `strictNullChecks: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `forceConsistentCasingInFileNames: true`
- **Rationale**: Prevents subtle undefined/null runtime errors, especially when handling untrusted documents, embeddings, and external API responses.
- **Consequences**: Code must explicitly handle potential undefined access from array indexing and optional fields.

---

## ADR-005: Schema-First Validation with Zod

- **Status**: Accepted
- **Context**: Untrusted inputs (environment variables, uploaded documents, search queries, LLM citations) must be validated before entering domain services.
- **Decision**: Standardize on Zod in `@devdocs/shared` and across services.
- **Rationale**:
  - Dual benefits of runtime parsing and compile-time TypeScript type inference from a single source of truth.
  - Fails fast on invalid configuration during service bootstrap.
  - Safe error reporting without exposing sensitive environment values.

---

## ADR-006: Structured Logging and Request Correlation

- **Status**: Accepted
- **Context**: Traceability across user requests and debugging retrieval pipelines requires structured logs without leaking credentials or proprietary data.
- **Decision**: Fastify Pino logger with correlation ID tracking:
  - Preserves incoming `x-request-id` or generates a cryptographically random UUID.
  - Automatic redaction of `authorization`, `cookie`, `x-api-key`, passwords, and secret tokens.
  - Structured output with level, timestamp, req ID, and HTTP status.
- **Rationale**: Compliance with non-functional security requirements (PRD Section 16 & 18).

---

## ADR-007: Safe Error Envelope & Boundary Isolation

- **Status**: Accepted
- **Context**: API errors must present a consistent structure to clients without leaking stack traces or internal database topologies in production.
- **Decision**: Centralized Fastify error handler mapping all errors to a standard envelope:
  ```json
  {
    "error": {
      "code": "BAD_REQUEST",
      "message": "Human readable message",
      "statusCode": 400,
      "requestId": "req-uuid"
    }
  }
  ```
- **Rationale**: Uniform error handling across web clients and API consumers. Production suppresses internal stack traces.

---

## ADR-008: Deferred Async Worker / Redis Infrastructure

- **Status**: Accepted
- **Context**: The PRD outlines an async worker with Redis and BullMQ for processing large ingestion runs, while Instruction 01 focuses on architecture foundation.
- **Decision**: Defer `apps/worker` and Redis dependencies to Phase 10 (Worker / Async Ingestion).
- **Rationale**:
  - Follows "avoid premature complexity" and PRD principle: build the end-to-end core before introducing distributed queuing complexity.
  - Keeps initial setup lightweight and cleanly testable.

---

## ADR-009: PostgreSQL with pgvector for Relational and Vector Storage

- **Status**: Accepted
- **Context**: The PRD requires a single primary data store for multi-tenant relational entities, document versioning, chat history, and dense vector embeddings.
- **Decision**: Standardize on PostgreSQL with the `pgvector` extension enabled via `CREATE EXTENSION IF NOT EXISTS vector;`.
- **Rationale**:
  - Eliminates the operational complexity of running separate vector databases (e.g. Pinecone, Qdrant, Milvus).
  - Unifies relational metadata filtering (tenant `organization_id`, document versions, access control) and vector similarity search in a single transactional query.
  - Supported natively in containerized environments (`pgvector/pgvector:pg17`) and local installations (Postgres.app).

---

## ADR-010: Sequential SQL Migrations with schema_migrations Tracking

- **Status**: Accepted
- **Context**: The database schema must be deterministic, versioned, repeatable from scratch in automated testing, and inspectable without opaque ORM abstractions.
- **Decision**: Use numbered SQL migration scripts (`001_enable_pgvector.sql`, `002_create_initial_schema.sql`) tracked via a dedicated `schema_migrations` table and executed with a custom transactional runner in `@devdocs/db`.
- **Rationale**:
  - Full control over specialized PostgreSQL features: `vector(1536)` types, `HNSW` vector indexes, and `tsvector` generated columns.
  - Transactional atomicity: each migration runs within `BEGIN ... COMMIT` with automatic rollback on error.
  - Zero proprietary ORM vendor lock-in; lightweight and reproducible across CI/CD and developer workstations.

---

## ADR-011: 1536-Dimensional Embeddings and HNSW Cosine Indexing

- **Status**: Accepted
- **Context**: Chunks must be embedded for semantic retrieval. The PRD specifies OpenAI `text-embedding-3-small` (1536 dimensions) as the baseline embedding model.
- **Decision**: Define `chunks.embedding` as `vector(1536)` and build an HNSW index using cosine distance: `USING hnsw (embedding vector_cosine_ops)`.
- **Rationale**:
  - HNSW (Hierarchical Navigable Small World) provides superior query throughput and recall compared to IVFFlat for interactive search without requiring list training.
  - Strict 1536 dimension typing prevents accidental ingestion of mismatched vector representations.

---

## ADR-012: PostgreSQL Full-Text Search via Stored Generated tsvector

- **Status**: Accepted
- **Context**: Hybrid search requires lexical retrieval for exact technical identifiers, function names, and error codes alongside semantic retrieval.
- **Decision**: Add `chunks.search_vector` as a stored generated column: `tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` backed by a GIN index: `USING GIN(search_vector)`.
- **Rationale**:
  - Automatic synchronization: whenever chunk content is inserted or updated, PostgreSQL automatically recalculates `search_vector`.
  - GIN indexing ensures sub-millisecond lexical inverted-index queries using `@@ to_tsquery()`.

---

## ADR-013: Database Reset Safeguards and Strict Test Isolation

- **Status**: Accepted
- **Context**: `db:reset` drops the public schema and deletes all data. An accidental reset in production or running tests against the application database could result in catastrophic data loss.
- **Decision**: Implement a defense-in-depth safety module (`@devdocs/db/safety`):
  1. Manual development reset requires explicit `NODE_ENV=development` AND `ALLOW_DB_RESET=true`. It unconditionally refuses unset environments, staging, production, or remote database host targets.
  2. Automated test suite reset uses a separate guarded path: requires `NODE_ENV='test'` (or Vitest), requires the target database name to end in `_test`, and explicitly rejects any target matching `DATABASE_URL` after parsing host, port, user, and database components.
  3. All database targets are logged with credentials redacted.
- **Rationale**: Prevents accidental data destruction from misconfigured environments, missing CLI arguments, or default fallbacks.

---

## ADR-014: Authentication, Organization Membership, and RBAC Model

- **Status**: Accepted
- **Context**: The platform requires secure multi-tenant isolation, user authentication, and granular role-based permissions (Admin, Member, Viewer) across workspaces. Client-side hiding of UI elements cannot be trusted as authorization.
- **Decision**:
  1. **Password Security**: Hash passwords using `bcryptjs` with 10 salt rounds. Plaintext passwords and hashes are never exposed in API responses or logs. Email addresses are consistently lowercased and trimmed.
  2. **JWT & Expiration**: Authenticated users receive signed JWT tokens with claims `{ userId, email, jti }` and an expiration time (default 24h). Tokens must be signed by the validated `JWT_SECRET` (minimum 32 characters in production).
  3. **Revocation & Logout Strategy**: Each JWT includes a cryptographically unique `jti` (UUID). On logout, the token's `jti` and expiration timestamp are recorded into a PostgreSQL table `revoked_tokens`.
     - *Trade-off*: Checking `revoked_tokens` during authentication adds a single fast index lookup (`SELECT jti FROM revoked_tokens WHERE jti = $1`). This provides immediate revocation without requiring external infrastructure (like Redis) prior to Phase 10. When Redis is introduced in Phase 10, the denylist lookup can be cached or moved to Redis TTL keys seamlessly.
  4. **Workspace Ownership & RBAC Hierarchy**:
     - Creating an organization atomically grants the creator an `Admin` membership.
     - Role hierarchy: `Admin` > `Member` > `Viewer`.
     - `Admin`: Manage members/roles, upload documents, re-index, delete resources, view analytics.
     - `Member`: Upload documents, trigger indexing, chat, ask questions, view citations.
     - `Viewer`: Read resources, search, chat, view citations; cannot mutate data or manage members.
     - Protected role operations enforce guards to prevent removing or demoting the last remaining admin in an organization.
  5. **Tenant Isolation & Non-Disclosure**:
     - Client-provided `organizationId` is never trusted without validating database membership for the authenticated user.
     - Cross-tenant access attempts return HTTP 404 (`ORGANIZATION_NOT_FOUND` / `RESOURCE_NOT_FOUND`) rather than 403, preventing unauthorized callers from enumerating the existence of external tenants or documents.

---

## ADR-015: In-Memory Document Staging, Parsing Pipeline, and Source Retention Strategy

- **Status**: Accepted
- **Context**: In Phase 4, documents (PDF, Markdown, TXT) must be uploaded via multipart/form-data, validated, parsed into structured representations (pages, sections, line numbers, word counts), and tracked with lifecycle processing status. Ephemeral container disks and local developer workstations may have strict storage constraints or lack persistent local file volumes.
- **Decision**:
  1. **In-Memory Streaming & Staging**: Fastify `@fastify/multipart` streams incoming file uploads directly into memory buffers strictly bounded by `MAX_FILE_SIZE_BYTES` (default 10MB). Temporary buffers are strictly scoped to the upload handler and garbage-collected immediately upon parse completion. No unmanaged temporary files are persisted to ephemeral container disks.
  2. **Multi-Layer Validation**:
     - Filename sanitization strips relative and absolute path traversal sequences (`../`, `..\`, leading `/`, null bytes) and normalizes POSIX and Windows path separators.
     - Whitelisted extensions and MIME types (`.pdf` -> `application/pdf`, `.md`/`.markdown` -> `text/markdown`, `.txt` -> `text/plain`).
     - Content verification checks magic bytes (`%PDF-` for PDF) and null-byte binary inspection for plain text and Markdown.
  3. **Content Hashing & Tenant Deduplication**:
     - Computes a deterministic SHA-256 hash across the raw uploaded payload.
     - Queries existing documents in the target organization for matching content hash. If an identical document exists, upload is rejected with HTTP 409 `DUPLICATE_DOCUMENT` containing the existing document ID and status, preventing redundant parsing, chunking, and embedding costs.
  4. **Structured Parsers**:
     - **PDF**: Parsed page-by-page via `unpdf` (PDF.js-based). Text glyphs are extracted per page. PDFs containing zero extractable text (scanned / image-only) transition to `failed` status with an actionable `PROCESSING_ERROR` indicating OCR is required.
     - **Markdown**: Parsed hierarchically, tracking heading levels (`#` through `######`), line start/end ranges, and verbatim preserving of code blocks (```) and lists.
     - **Text**: Line-based normalization preserving whitespace, formatting, and character/word counts.
  5. **Persistence & Source Retention**:
     - Extracted document text, page structures, hierarchical sections, and metrics are persisted in the PostgreSQL `document_versions.source_details` JSONB column.
     - The document lifecycle transitions across `queued` -> `processing` -> `ready` (or `failed` with error details upon malformed content), strictly adhering to the database `chk_doc_versions_status` constraint.
     - Persisting structured parse results directly in PostgreSQL ensures that Phase 5 (Chunking & Embeddings) can reliably access clean page/section text without re-reading raw files or relying on ephemeral container storage.

---

## ADR-016: Structure-Aware Chunking, Native Fetch OpenAI Embedding Provider & pgvector Persistence Pipeline

- **Status**: Accepted
- **Context**: In Phase 5, extracted document text must be converted into high-quality searchable chunks, embedded via OpenAI text embeddings (`text-embedding-3-small`, 1536 dimensions), and persisted atomically into PostgreSQL pgvector for semantic retrieval. Ephemeral container disks and local environments require zero unnecessary third-party package dependencies, secret redaction, and deterministic reproducibility in tests without incurring real API costs.
- **Decision**:
  1. **Validation & Structure-Preserving Normalization**:
     - Raw extracted text is validated for non-emptiness from `document_versions.source_details.rawText`.
     - Line endings are normalized to standard LF (`\n`). Dangerous ASCII control characters are stripped while preserving tabs (`\t`) and newlines (`\n`). Typographical quotes and dashes are standardized.
     - Trailing whitespace is trimmed per line while preserving leading whitespace to maintain code block and list indentations.
  2. **Structure-Aware Chunking Engine**:
     - **Markdown**: Extracts headings hierarchically (`H1` through `H6`), tracking section title, heading level, and line start/end numbers. Fenced code blocks are kept intact within single chunks wherever possible.
     - **PDF**: Preserves page boundaries and numbers (`page_number`), generating sub-chunks with configured overlap when page length exceeds chunk size.
     - **Plain Text**: Slices on paragraph breaks (`\n\n`), falling back to sentence and word boundaries for oversized blocks.
     - **Configurable Defaults**: Default chunk size of 800 characters, overlap of 120 characters, and minimum chunk size of 50 characters. Tiny fragments are merged into adjacent chunks within the same section.
     - **Deterministic Chunk Ordering**: Slices are assigned sequential 0-based indices (`chunk_index = 0, 1, 2, ...`). The output is strictly deterministic across repeated runs on identical content.
  3. **EmbeddingProvider Abstraction & Zero-Dependency OpenAI Adapter**:
     - `EmbeddingProvider` interface defines `model`, `dimensions`, and `embedChunks(texts: string[]): Promise<number[][]>`.
     - `OpenAIEmbeddingProvider` utilizes native Node 22 `fetch` and `AbortSignal.timeout` with zero extra npm packages.
       - Batches chunk inputs (default batch size: 100) to respect provider payload limits.
       - Validates returned vectors for exact dimensionality (1536) and finite numeric values (`Number.isFinite`).
       - Redacts API keys (`sk-...`) and Bearer tokens from error strings before propagation.
     - `MockEmbeddingProvider` generates deterministic 1536-dimensional L2-normalized unit vectors based on SHA-256 content hashing, enabling cosine distance searches (`<=>`) in offline integration tests without live OpenAI credentials.
  4. **Transactional pgvector Chunk Persistence**:
     - Chunks and embeddings are stored in PostgreSQL `chunks` table using `withTransaction`.
     - Embeddings are parameterized as pgvector literal string format `[x,y,...]::vector`.
     - The `search_vector` tsvector column is populated automatically by PostgreSQL stored generated expressions.
     - Re-ingestion is idempotent: pre-existing chunks for the document version are cleared within the transaction prior to re-inserting.
  5. **Failure Semantics & Transport Independence**:
     - If any pipeline stage fails (validation, normalization, chunking, embedding, persistence), the document version transitions to `failed` status, recording `errorStage` and a sanitized `error_message` in `source_details`. Partial chunks are rolled back atomically.
     - The ingestion pipeline is purely functional and transport-independent (`ingestDocumentVersion`), callable synchronously from the document upload handler or asynchronously from future worker queues without duplicating logic.
