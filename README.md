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
Safe default values are provided in `.env.example`. Review `DATABASE_URL` for your local PostgreSQL setup.

### 3. Run Database Migrations
```bash
# Check migration status
npm run db:status

# Apply versioned SQL migrations (enables pgvector and sets up core tables)
npm run db:migrate
```

### 4. Start Development Servers
```bash
# Starts both API (port 4000) and Web (port 5173) concurrently
npm run dev
```

Visit:
- **Web Frontend**: [http://localhost:5173](http://localhost:5173)
- **API Health**: [http://localhost:4000/health](http://localhost:4000/health)

---

## Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Runs both API and Web applications concurrently |
| `npm run dev:api` | Runs Fastify API in watch mode via `tsx` |
| `npm run dev:web` | Runs Vite React frontend development server |
| `npm run build` | Builds `@devdocs/shared`, `@devdocs/db`, `@devdocs/api`, and `@devdocs/web` |
| `npm run typecheck` | Typechecks all packages using strict TypeScript |
| `npm run test` | Runs the Vitest test suite across all packages (shared, api, db) |
| `npm run db:status` | Shows migration history and applied timestamps |
| `npm run db:migrate` | Runs all pending SQL migrations against `DATABASE_URL` |
| `npm run db:reset` | Resets local database (drops schema, reapplies migrations from scratch) |
| `npm run lint` | Runs TypeScript lint checks across all packages |
| `npm run clean` | Cleans build output directories |

---

## Architecture & Conventions

- **Strict Type Safety**: Strict TypeScript compiler flags enforced across all workspaces (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Relational & Vector Storage**: PostgreSQL with `pgvector` (1536-dimensional embeddings for OpenAI `text-embedding-3-small` with HNSW cosine indexing).
- **Hybrid Lexical Search**: Automatic full-text search `tsvector` generated column with GIN indexing on chunk contents.
- **Structured Logging & Redaction**: Fastify Pino logger with sensitive header/token redaction (`authorization`, `cookie`, `x-api-key`, `password`, `token`).
- **Traceability**: Unique correlation ID assigned to every request (`x-request-id` header or generated UUID).
- **Safe Error Envelopes**: Centralized error formatting preventing secret/stack leaks in client responses.
- **Decision Records**: Detailed trade-offs and rationale documented in [docs/architecture/decisions.md](docs/architecture/decisions.md).

---

## Current Project Status & Limitations

- **Current Phase**: **Instruction 02 — PostgreSQL Schema and Migrations (Completed)**.
- **Active Capabilities**:
  - Fastify REST API with liveness/readiness health probes
  - React frontend with live API connectivity diagnostics
  - 12 core relational tables with UUID primary keys and multi-tenant constraints
  - pgvector enabled with 1536-dim vector storage and HNSW cosine similarity search
  - Automated full-text search (`search_vector` generated column + GIN index)
  - Sequential SQL migration engine (`db:status`, `db:migrate`, `db:reset`)
- **Intentional Limitations (Scheduled for Later Phases)**:
  - Authentication, password hashing & RBAC are scheduled for **Instruction 03**.
  - Document parsing, chunking & OpenAI embeddings are scheduled for **Phases 04–05**.
  - Hybrid RAG & Grounded Chat are scheduled for **Phases 06–08**.
  - Redis / BullMQ async workers are scheduled for **Phase 10**.

For full details, review [docs/project-status.md](docs/project-status.md).
