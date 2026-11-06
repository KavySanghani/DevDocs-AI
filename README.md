# DevDocs AI — Engineering Knowledge & Codebase Assistant

DevDocs AI is an engineering knowledge platform designed for software teams. It provides citation-backed hybrid retrieval-augmented generation (RAG) across technical documentation and codebases, tracing answers to exact document sections, pages, or repository files and line numbers.

---

## Architecture Overview

DevDocs AI is structured as a modular TypeScript monorepo using standard npm workspaces:

```
DevDocs-AI/
├── apps/
│   ├── api/                  # Fastify 5 + TypeScript REST API
│   │   ├── src/
│   │   │   ├── app.ts        # App factory & plugin registration
│   │   │   ├── index.ts      # Server entrypoint & graceful shutdown
│   │   │   ├── config/       # Zod environment validation & Pino logger
│   │   │   ├── plugins/      # Safe error handler & correlation IDs
│   │   │   └── routes/       # Health & liveness endpoints
│   │   └── tests/            # Unit & integration tests (Vitest)
│   └── web/                  # React 18 + Vite frontend
│       ├── src/
│       │   ├── App.tsx       # Live health probe & architecture dashboard
│       │   ├── index.css     # Dark mode design tokens & styling
│       │   └── config/       # Safe client runtime config
│       └── index.html        # Semantic HTML5 entrypoint
├── packages/
│   ├── shared/               # Shared domain contracts & Zod schemas
│   └── db/                   # Database pool, transaction helpers & migration runner
├── db/
│   └── migrations/           # Versioned SQL migrations (001_pgvector, 002_schema)
├── docs/
│   ├── architecture/
│   │   └── decisions.md      # Architecture Decision Records (ADRs 001-012)
│   ├── project-status.md     # Phase tracker & verification evidence
│   └── setup.md              # Detailed developer setup guide
├── planning/                 # PRD and execution prompt specifications (ignored by Git)
├── docker-compose.yml        # Local PostgreSQL container with pgvector
├── .env.example              # Environment configuration template
└── package.json              # Monorepo workspaces & lifecycle scripts
```

---

## Prerequisites

- **Node.js**: `>= 20.0.0` (tested with v22.19.0)
- **npm**: `>= 10.0.0`
- **PostgreSQL**: PostgreSQL 16+ with the `pgvector` extension (tested with Postgres 18 + pgvector 0.8.2 locally, or Docker container `pgvector/pgvector:pg17`)
- **Redis**: Redis 6+ / 7+ (default: `redis://127.0.0.1:6379`) for BullMQ background ingestion queues
- **Git**

---

## Quickstart

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Safe default values are provided in `.env.example`. Review `DATABASE_URL` and `REDIS_URL` for your local setup.

### 3. Run Database Migrations
```bash
# Check migration status
npm run db:status

# Apply versioned SQL migrations (enables pgvector and sets up core tables)
npm run db:migrate
```

### 4. Start Development Servers

You can run the API server and the background ingestion worker as separate processes:

```bash
# Terminal 1: Fastify API server (port 4000)
npm run dev:api

# Terminal 2: Background Ingestion Worker
npm run dev:worker

# Terminal 3: Vite React Web Frontend (port 5173)
npm run dev:web
```

Or run all development services concurrently:
```bash
npm run dev
```

Visit:
- **Web Frontend**: [http://localhost:5173](http://localhost:5173)
- **API Health**: [http://localhost:4000/health](http://localhost:4000/health)

---

## Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Runs API and Web applications concurrently |
| `npm run dev:api` | Runs Fastify API in watch mode via `tsx` |
| `npm run dev:worker` | Runs BullMQ background ingestion worker in watch mode via `tsx` |
| `npm run dev:web` | Runs Vite React frontend development server |
| `npm run worker` | Runs standalone background ingestion worker (production) |
| `npm run build` | Builds `@devdocs/shared`, `@devdocs/db`, `@devdocs/api`, and `@devdocs/web` |
| `npm run typecheck` | Typechecks all packages using strict TypeScript |
| `npm run test` | Runs the Vitest test suite across all packages (shared, api, db) |
| `npm run db:status` | Shows migration history and applied timestamps |
| `npm run db:migrate` | Runs all pending SQL migrations against `DATABASE_URL` |
| `npm run db:reset` | Resets local test database (drops schema, reapplies migrations) |
| `npm run lint` | Runs TypeScript lint checks across all packages |
| `npm run clean` | Cleans build output directories |

---

## Background Worker & Asynchronous Ingestion (Phase 10)

DevDocs AI coordinates long-running document ingestion and re-indexing operations via an asynchronous background worker powered by **BullMQ** and **Redis**, backed by PostgreSQL as the authoritative source of truth.

### Architecture & Coordination
- **Decoupled Processes**: The Fastify API server and the BullMQ background worker run as independent Node.js processes from the same codebase.
- **Durable State Machine**: The PostgreSQL `jobs` table maintains durable status across `queued`, `processing`, `retrying`, `ready`, and `failed`. Queue IDs deterministically match PostgreSQL `jobId` to prevent duplicate enqueues.
- **Asynchronous Triggers**: Any ingestion or re-indexing request can be dispatched asynchronously using:
  - Query parameter: `?async=true`
  - HTTP Header: `Prefer: respond-async`
  - Request body field: `{ "async": true }`
- **HTTP 202 Accepted**: Returns immediately with `{ jobId, status: "queued", documentId, versionId }`.
- **Status Inspection**: Clients poll `GET /api/jobs/:id` for authoritative progress stage, attempt counters, and error summaries. Strictly scoped by organization membership (returns 404 for cross-tenant attempts).

### Worker Environment Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL for BullMQ queue coordination |
| `WORKER_CONCURRENCY` | `5` | Maximum number of concurrent ingestion jobs processed per worker |
| `INGESTION_MAX_ATTEMPTS` | `3` | Maximum attempts for retryable transient failures |
| `INGESTION_BACKOFF_MS` | `1000` | Base exponential backoff delay (ms) between retries |

### Distributed Leases, Heartbeats & Split-Brain Fencing
- **Lease Ownership**: When a worker begins processing a job, it atomically claims a time-bounded lease (`locked_by`, `locked_until`) and increments the job's `fencing_token`.
- **Heartbeat Renewal**: Active workers periodically renew their lease via background heartbeat. If a worker process hangs or crashes, its lease expires automatically.
- **Fencing Protection**: A worker that loses its lease/fence cannot commit chunks, finalize the job as ready, or displace the document's `current_version_id`.
- **Safe Recovery**: Stale processing jobs whose leases have expired are automatically reclaimed by the recovery scanner and retried or failed gracefully.

### Periodic Recovery Scanner
- **Startup & Periodic Scans**: The worker runs an initial recovery scan at startup and executes recurring background sweeps (default: every 30s) to reclaim stranded queued or expired processing jobs (e.g. if Redis experienced a network outage).
- **Graceful Shutdown**: Handles `SIGINT` and `SIGTERM` signals by clearing recovery timers, draining active worker jobs, and cleanly closing Redis clients and database pools.

### Re-Index Idempotency
- **Client Idempotency Keys**: Re-index requests support a client-supplied `Idempotency-Key` header (e.g., `Idempotency-Key: my-task-uuid`).
- **Scoped Deduplication**: Keys are scoped to `(organization_id, document_id, version_id, idempotency_key)` to prevent duplicate concurrent jobs while allowing fresh intentional re-indexes.

---

## Current Project Status

- **Current Phase**: **Instruction 10 — Redis Queue, Worker, Retries, and Idempotency (Completed)**.
- **Verified Capabilities**:
  - Full Fastify REST API with JWT authentication and RBAC (`Admin`, `Member`, `Viewer`)
  - Multi-tenant organization isolation with zero cross-tenant resource leakage
  - Multipart document upload for PDF, Markdown, and TXT with SHA-256 deduplication
  - Structure-aware chunking preserving Markdown headings and PDF page numbers
  - Zero-dependency OpenAI embedding provider (`text-embedding-3-small`, 1536d) with pgvector HNSW indexing
  - Hybrid search combining semantic vector cosine distance with PostgreSQL full-text search (`tsvector`/GIN) via Reciprocal Rank Fusion (RRF)
  - Grounded Groq RAG generation with delimited context citations and strict anti-hallucination prompts
  - Multi-turn grounded chat sessions with citation validation and deletion tombstones
  - Sequential document version allocation (F-01 row-locked) and monotonic current version activation (F-04)
  - Line-level text diffing between document versions
  - BullMQ & Redis background worker architecture with bounded concurrency and exponential retries
  - Distributed lease heartbeats, fencing tokens, stale processing recovery, and re-index idempotency
  - 100% backward-compatible synchronous ingestion fallback

For complete verification history, review [docs/project-status.md](docs/project-status.md) and [docs/architecture/decisions.md](docs/architecture/decisions.md).
