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
│   └── shared/               # Shared domain contracts & Zod schemas
├── db/
│   └── migrations/           # Versioned SQL migrations (Phase 02+)
├── docs/
│   ├── architecture/
│   │   └── decisions.md      # Architecture Decision Records (ADRs)
│   ├── project-status.md     # Phase tracker & verification evidence
│   └── setup.md              # Detailed developer setup guide
├── planning/                 # PRD and execution prompt specifications
├── .env.example              # Environment configuration template
└── package.json              # Monorepo workspaces & lifecycle scripts
```

---

## Prerequisites

- **Node.js**: `>= 20.0.0` (tested with v22.19.0)
- **npm**: `>= 10.0.0`
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
Safe default values are provided in `.env.example`. No third-party API keys or external services are required for Phase 01.

### 3. Start Development Servers
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
| `npm run build` | Builds `@devdocs/shared`, `@devdocs/api`, and `@devdocs/web` |
| `npm run typecheck` | Typechecks all packages using strict TypeScript |
| `npm run test` | Runs the Vitest test suite across all packages |
| `npm run clean` | Cleans build output directories |

---

## Architecture & Conventions

- **Strict Type Safety**: Strict TypeScript compiler flags enforced across all workspaces (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Structured Logging & Redaction**: Fastify Pino logger with sensitive header/token redaction (`authorization`, `cookie`, `x-api-key`, `password`, `token`).
- **Traceability**: Unique correlation ID assigned to every request (`x-request-id` header or generated UUID).
- **Safe Error Envelopes**: Centralized error formatting preventing secret/stack leaks in client responses.
- **Decision Records**: Detailed trade-offs and rationale documented in [docs/architecture/decisions.md](docs/architecture/decisions.md).

---

## Current Project Status & Limitations

- **Current Phase**: **Instruction 01 — Architecture & Bootstrap (Completed)**.
- **Active Capabilities**: Fastify REST API with liveness/readiness health probes, Zod environment validation, React frontend with live API connectivity diagnostics, test coverage, and documentation.
- **Intentional Limitations (Scheduled for Later Phases)**:
  - Database schema & pgvector storage are scheduled for **Instruction 02**.
  - Authentication & RBAC are scheduled for **Instruction 03**.
  - Document parsing, chunking & OpenAI embeddings are scheduled for **Phases 04–05**.
  - Hybrid RAG & Grounded Chat are scheduled for **Phases 06–08**.
  - Redis / BullMQ async workers are scheduled for **Phase 10**.

For full details, review [docs/project-status.md](docs/project-status.md).
