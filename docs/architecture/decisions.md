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
