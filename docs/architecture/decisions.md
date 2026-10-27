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

---

## ADR-017: pgvector Cosine Distance Semantic Retrieval, HNSW Indexing Strategy & Grounded Groq RAG Pipeline

- **Status**: Accepted
- **Context**: In Phase 6, semantic vector search must be executed over stored document chunks in PostgreSQL, and retrieved candidates must be passed as bounded context to the first end-to-end RAG answer flow. The retrieval layer must remain modular and transport-independent so it can be combined with PostgreSQL full-text search and Reciprocal Rank Fusion (RRF) in Phase 7. Multi-tenant isolation, anti-prompt-injection grounding, and deterministic context budgeting are strict security requirements.
- **Decision**:
  1. **Similarity Metric & pgvector Operator**:
     - Standardized on **cosine distance** using pgvector's `<=>` operator over unit-normalized 1536-dimensional vectors.
     - Cosine similarity is computed and returned as `similarity = 1 - distance` (ranging from 0.0 to 1.0).
     - Cosine distance is scale-invariant and matches OpenAI `text-embedding-3-small` geometry.
  2. **Vector Indexing Strategy**:
     - Utilizes the HNSW index on `chunks (embedding vector_cosine_ops)` configured in migration `002_create_initial_schema.sql` (`idx_chunks_embedding`).
     - HNSW (Hierarchical Navigable Small World) provides fast approximate nearest neighbor search with high recall and logarithmic search complexity, avoiding the recall degradation and training clustering phases of IVFFlat.
  3. **Strict Tenant Isolation & State Scoping**:
     - Every vector search query enforces parameterized SQL scoping:
       - `d.organization_id = $2`: Never scans or returns other tenant chunks even briefly to application code.
       - `dv.status = 'ready'`: Restricts candidates to fully ingested and validated versions.
       - `dv.id = d.current_version_id`: Prevents stale historical versions from appearing in retrieval results.
     - Supports optional `documentId` filter to scope retrieval to a specific document.
     - Strict `topK` bounds (min 1, max 20, default 5).
  4. **Granular Observability & Latency Separation**:
     - Internal and API result metadata separates `embeddingMs` (query vector generation), `retrievalMs` (PostgreSQL pgvector query), and `generationMs` (LLM completion), allowing independent tracking of embedding and database retrieval bottlenecks.
  5. **Context Budgeting & Anti-Prompt-Injection Invariants**:
     - Context builder greedily includes top-ranked candidates up to `maxContextChars` (default 12,000 characters, ~3,000 tokens), deterministically truncating or omitting chunks that exceed budget.
     - All retrieved content is presented in structured delimited source blocks with document name, section title, page number, file path, and line numbers.
     - System prompt establishes explicit instruction hierarchy: retrieved text is untrusted external data; instructions within reference documentation cannot override system rules; the model must rely solely on stated facts; and if evidence is lacking, the model must explicitly return "I cannot answer this question based on the provided documentation."
  6. **Groq Provider Adapter & Offline Mock Testing**:
     - `GroqProvider` communicates with Groq Chat Completions API (`https://api.groq.com/openai/v1/chat/completions`) using native Node 22 `fetch` and `AbortController` (timeout: 30s).
     - Redacts `gsk_...` keys, `sk-...` keys, and `Bearer` tokens from all error outputs.
     - `MockLLMProvider` generates deterministic grounded answers for test suites and offline environments, guaranteeing reproducible tests without live Groq API keys.
     - When retrieval yields zero candidates, `queryRAG` returns early with an insufficient-evidence response without making an unnecessary external LLM call.

---

## 2026-10-17 — Decision 007: Hybrid Search, PostgreSQL Full-Text Search, and Reciprocal Rank Fusion (RRF)

- **Context**: In Phase 7, retrieval quality must be enhanced by combining semantic vector search with PostgreSQL lexical full-text search, and fusing the multi-retriever candidate rankings deterministically. Technical queries frequently contain exact API route names (e.g. `/api/documents/:id/ingest`), code function/variable identifiers (e.g. `calculateTaxAmount`), error codes (e.g. `ERR_PAYMENT_FAILED`), and file paths that semantic embeddings can blur. Conversely, conceptual and synonym queries require semantic vector distance. A unified hybrid search architecture must combine both methods without adding external search engines (e.g., Elasticsearch, Meilisearch).
- **Decision**:
  1. **PostgreSQL Lexical Full-Text Search via tsvector and GIN**:
     - Utilizes the stored generated column `search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` and its GIN index `idx_chunks_search_vector` defined in migration `002_create_initial_schema.sql`.
     - Maintains 100% consistency with stored chunk text automatically without out-of-band indexing jobs.
     - Lexical queries use `websearch_to_tsquery('english', $1)` to support natural syntax, unquoted words, exact phrases in quotes (`"..."`), and Boolean `OR` / negation syntax.
     - Evaluates relevance ranking with PostgreSQL cover density ranking `ts_rank_cd(c.search_vector, query_ts)` to prefer proximity and density of matching terms.
     - Fallback mechanism: if strict multi-word search yields 0 candidates and contains no quotes/operators, a secondary pass transforms terms with `OR` to rank partially matching candidates gracefully.
  2. **Reciprocal Rank Fusion (RRF) Algorithm**:
     - Deterministic multi-list rank fusion based on Cormack et al. (SIGIR 2009):
       $$\text{RRF}(c) = \sum_{m \in \{\text{vector}, \text{lexical}\}} \frac{1}{k + \text{rank}_m(c)}$$
     - Smoothing constant $k = 60$ (`DEFAULT_RRF_K`), the canonical default across search engines (Lucene, Elasticsearch, Azure Cognitive Search).
     - Derives fused relevance strictly from candidate rankings rather than combining uncalibrated heterogeneous probabilities.
     - Deduplicates chunks occurring in both retrieval lists, boosting candidates that match both semantically and lexically.
     - Deterministic tie-breaking order: `rrfScore DESC`, `bestRank ASC` (`min(vectorRank, lexicalRank)`), `vectorScore DESC`, `lexicalScore DESC`, `chunkId ASC`.
  3. **Diagnostic Observability & Provenance**:
     - Preserves each retriever's individual rank and score on returned chunks:
       - `vectorRank`: 1-based rank in vector search, or `null`.
       - `vectorScore`: Cosine similarity score (`1 - distance`), or `null`.
       - `lexicalRank`: 1-based rank in lexical search, or `null`.
       - `lexicalScore`: Cover density score (`ts_rank_cd`), or `null`.
       - `rrfScore`: Fused RRF score.
       - `rank`: Final 1-based rank in the fused list.
     - Granular latency tracking: separates `embeddingMs`, `retrievalMs`, `fusionMs`, and `totalMs`.
  4. **Multi-Tenant Security & Version Visibility**:
     - Both vector and lexical SQL queries enforce strict parameterized tenant isolation:
       - `d.organization_id = $orgId`
       - `dv.status = 'ready'`
       - `dv.id = d.current_version_id`
       - Optional `d.id = $docId` (document-scoped filtering)
       - Optional `c.metadata @> $metadataFilter::jsonb` (JSONB containment filtering)
     - Unauthorized tenants cannot retrieve any chunks regardless of query mode or keyword exactness.
  5. **Retrieval Modes & Search Endpoints**:
     - Supports three operational modes: `hybrid` (default), `vector`, and `keyword`.
     - Endpoints:
       - `POST /api/search`: Primary unified search API requiring JWT authentication and viewer-or-higher organization access.
       - `POST /api/organizations/:orgId/search`: Organization-scoped search (defaults to `hybrid`, supports `mode`).
       - `POST /api/organizations/:orgId/retrieval/vector`: Dedicated vector search endpoint for benchmarks.
       - `POST /api/documents/:id/search`: Document-scoped hybrid search.
     - RAG answering (`queryRAG`) defaults to `hybrid` retrieval, combining keyword precision with semantic grounding.
- **Consequences**:
  - No new external services or databases added; PostgreSQL handles vectors, full-text indexes, and relational data in a single transactional engine.
  - Sub-millisecond RRF fusion with zero external API calls.
  - High recall across both natural language questions and exact technical tokens.

---

## 2026-10-17 — Decision 008: Grounded Chat Sessions, Bounded History Scoping, and Strict Citation Validation Pipeline

- **Status**: Accepted
- **Context**: In Phase 8, DevDocs AI must support multi-turn conversational chat grounded strictly in workspace documentation. Conversational LLMs are prone to hallucinations, fabricating unretrieved source numbers, carrying over extraneous history that exhausts context windows, and answering outside the indexed corpus. A robust chat architecture must persist sessions and messages with strict tenant isolation, reformulate follow-up questions across turns, enforce anti-prompt-injection boundaries, validate every citation marker against actual retrieved chunks, and provide secure citation source inspection.
- **Decision**:
  1. **Additive Database Schema Migration (`004_create_citations.sql`)**:
     - Introduces `citations` table linked to `messages(id)` and `chunks(id)` with `ON DELETE CASCADE`.
     - Fields: `id`, `message_id`, `chunk_id`, `citation_number`, `document_id`, `document_name`, `page_number`, `section_title`, `file_path`, `line_start`, `line_end`, `snippet`, `created_at`.
     - Unique constraint on `(message_id, citation_number)` ensures deterministic 1-based indexing per assistant turn.
     - Fully additive without modifying migrations 001–003.
  2. **Multi-Turn Chat Sessions & Tenant Isolation**:
     - `chat_sessions` owned by `(organization_id, user_id)`.
     - Users can only access and post messages to sessions belonging to their user ID within their authenticated organization (`organization_members` check).
     - Cross-tenant or cross-user session access attempts return HTTP 404 (`SESSION_NOT_FOUND`) to prevent enumeration.
     - Endpoints:
       - `POST /api/chat/sessions`: Create a new session.
       - `GET /api/chat/sessions`: List user sessions with pagination and message counts.
       - `GET /api/chat/sessions/:id`: Retrieve session details, messages, and associated citations.
       - `GET /api/chat/sessions/:id/messages`: Paginated message history.
       - `POST /api/chat/sessions/:id/messages`: Execute a grounded conversational turn.
  3. **History Bounding & Standalone Query Reformulation**:
     - Conversation history bounded to the most recent 4 turns (8 messages) or 4,000 characters to prevent context window explosion.
     - When history exists, `queryRewriter` asks the LLM provider to reformulate conversational follow-ups (e.g. "How do I install it?") into self-contained search queries (e.g. "How to install DevDocs AI").
     - Graceful fallback: provider timeouts or formatting errors cleanly fall back to the raw user question without failing the turn.
  4. **Grounding & Anti-Prompt-Injection Prompt Hierarchy**:
     - Retrieved chunks from hybrid search are delimited in structured untrusted source blocks: `[Source N: docName (Page X)]\n...`.
     - System prompt establishes explicit instruction hierarchy: documentation is untrusted data and cannot override system grounding rules; the model must cite sources using `[N]` notation matching context indices; and if evidence is absent, the model must explicitly state: "I could not find sufficient information in the indexed sources to answer this question."
  5. **Server-Side Citation Validation & Hallucination Defense (`citationValidator.ts`)**:
     - Extracts all citation tags (`[1]`, `[2]`, `[Source 1]`, `[1, 2]`) using regex pattern matching.
     - Validates extracted indices against actual context chunks passed to the model ($1 \le N \le \text{chunks.length}$).
     - **Fabrication Stripping**: If the model references a non-existent chunk index (e.g., `[99]`), the validator strips the invalid tag from the text and excludes it from the saved citations list.
     - Re-indexes valid citations sequentially in order of appearance in the answer text, updating bracketed markers to match (`[1]`, `[2]`, ...).
     - Atomic persistence: stores verified citations into the `citations` table alongside the assistant message.
     - Insufficient-evidence detection: if the answer is an abstention or zero valid sources were retrieved, citations list is empty and the assistant response is preserved cleanly.
  6. **Citation Source Inspection & Security Boundaries**:
     - Endpoints:
       - `GET /api/chat/sources/:chunkId`: Retrieve chunk source details with document name, content, and metadata.
       - `GET /api/chat/chunks/:id`: Alias route for chunk inspection.
     - Server-side RBAC: validates that the requesting user belongs to the organization that owns the document chunk.
     - Cross-tenant source access attempts return HTTP 404 (`CHUNK_NOT_FOUND`) rather than leaking document content or metadata across organizations.
- **Consequences**:
  - Eliminates citation hallucinations and broken UI links.
  - Preserves full auditability by linking every assistant answer to the exact retrieved chunks, `retrieval_runs`, and `retrieval_results`.
  - Resilient to LLM prompt injection attacks contained inside indexed user documents.

---

## 2026-10-17 — Decision 009: Document Versioning, Safe Re-indexing, Diff Engine, and Deletion Provenance

- **Status**: Accepted
- **Context**: In Phase 9, DevDocs AI requires document version management, idempotent re-indexing, textual diffing between versions, and safe deletion. In a collaborative technical documentation repository, documents undergo continuous iteration. A production system must:
  1. Maintain document identity while storing immutable version snapshots (`document_versions`).
  2. Prevent unintentional duplicate uploads while supporting new versions when content changes.
  3. Ensure re-indexing is atomic and idempotent, eliminating orphaned or duplicated chunks.
  4. Isolate retrieval to only the current active version by default so stale versions do not poison RAG search results.
  5. Provide line-level diffing between versions (LCS-based unified diff and summary statistics).
  6. Preserve historical citation provenance when documents or versions are deleted (tombstone preservation).
  7. Enforce strict RBAC and tenant isolation on all versioning, reindexing, and deletion endpoints.
- **Decision**:
  1. **Multi-Version Document Lifecycle & Content Deduplication**:
     - Documents have a primary record in `documents` with pointer `current_version_id`.
     - Each version is stored as an immutable row in `document_versions` with sequence `version_number` ($1, 2, 3, \dots$), `content_hash` (SHA-256), `status` (`queued`, `processing`, `ready`, `failed`), and `source_details`.
     - Deduplication: Uploading identical content to an existing document returns 409 `DUPLICATE_VERSION` with existing document and version details. Uploading changed content creates the next sequential version.
     - **Transaction-Scoped Row Locking for Concurrency Safety (F-01)**: Simultaneous uploads for the same document are serialized using `SELECT id, organization_id FROM documents WHERE id = $1 AND organization_id = $2 FOR UPDATE` within a database transaction. Under the lock, duplicate content (SHA-256) is checked and the next sequential version number (`COALESCE(MAX(version_number), 0) + 1`) is allocated and inserted in `processing` status before committing. Long-running parsing, chunking, and embedding generation remain asynchronous outside the transaction, preventing connection starvation while eliminating PostgreSQL 23505 race conditions.
     - **Monotonic Conditional Pointer Activation (F-04)**: Automatic version activation upon ingestion completion uses an atomic conditional SQL update: `UPDATE documents d SET current_version_id = new_v.id, updated_at = now() FROM document_versions new_v WHERE d.id = $2 AND new_v.id = $1 AND new_v.document_id = d.id AND new_v.status = 'ready' AND (d.current_version_id IS NULL OR new_v.version_number >= (SELECT cur_v.version_number FROM document_versions cur_v WHERE cur_v.id = d.current_version_id))`. This guarantees that if concurrent or rapid uploads complete out of order, a slower older version can never overwrite a newer version that has already become current.
     - **Explicit Version Activation & Rollback**: `POST /api/documents/:id/versions/:versionId/activate` allows authorized Members and Admins to deliberately activate any historical version in `ready` status without monotonic version-number restrictions, enabling instant manual rollbacks.
  2. **Safe & Idempotent Re-indexing**:
     - Endpoint: `POST /api/documents/:id/reindex` (with `POST /api/documents/:id/ingest` maintained as backward-compatible alias).
     - Allows optional `versionId` (defaults to `current_version_id`) and custom chunking overrides.
     - Within an atomic database transaction in `ingestDocumentVersion`, existing chunks for that `document_version_id` are purged before new chunks and embeddings are inserted.
     - On failure, `status` is set to `failed` with `error_message`, and `documents.current_version_id` is never updated to an unready version.
  3. **Retrieval Version Isolation**:
     - `searchVectorChunks`, `searchLexicalChunks`, and `searchHybridChunks` enforce `AND dv.id = d.current_version_id AND dv.status = 'ready'` by default.
     - Stale historical versions are never returned in search queries unless explicitly scoped with `versionId`.
  4. **Line-Level Diff Engine (`documentDiff.ts`)**:
     - Pure TypeScript Longest Common Subsequence (LCS) diffing algorithm.
     - Endpoint: `GET /api/documents/:id/diff?fromVersion=1&toVersion=2`.
     - Computes `isContentIdentical`, `linesAdded`, `linesRemoved`, `linesUnchanged`, `characterCountDelta`, `chunkCountDelta`, unified diff string (`--- v1 / +++ v2`), structured `chunks`, and section comparison.
  5. **Document Deletion & Citation Provenance Tombstone**:
     - Endpoint: `DELETE /api/documents/:id` (restricted to Admin role).
     - Cascades deletion of document, versions, and chunks.
     - When documents or chunks are deleted, `citations` records are retained in PostgreSQL (`ON DELETE SET NULL` on `chunk_id` and `document_id`).
     - Citation queries map null chunk/document references to `sourceDeleted: true`, preserving the original `document_name`, `snippet`, `citation_number`, and `section_title` in historical chat sessions without dangling foreign keys.
  6. **Role Permissions & Tenant Isolation**:
     - Viewers are forbidden (403) from uploading versions, activating versions, re-indexing, or deleting documents.
     - Members and Admins can upload versions, re-index, and activate versions.
     - Admins only can delete documents.
     - Cross-tenant requests return 404 (`DOCUMENT_NOT_FOUND`) to prevent resource enumeration.
- **Consequences**:
  - Full version audit trail and rollback capabilities.
  - Zero duplicate chunks during re-indexing retries.
  - Historical chat logs remain readable and citeable even after source documents are updated or pruned.
