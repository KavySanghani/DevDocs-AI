# DevDocs AI — Developer Setup Guide

This guide covers setting up your local development environment for DevDocs AI.

---

## 1. Prerequisites

- **Node.js**: `v20.0.0` or higher (verified on Node `v22.x`)
- **npm**: `v10.0.0` or higher
- **PostgreSQL with pgvector**:
  - Local installation with pgvector (e.g. Postgres.app on port 5433 with vector 0.8+)
  - OR Docker with `pgvector/pgvector:pg17` on port 5432 (`docker compose up -d`)
- **Git**: Installed and configured

---

## 2. Environment Setup

1. Copy the environment configuration template:
   ```bash
   cp .env.example .env
   ```

2. Review the variables in `.env`:
   - `PORT`: API server port (default: `4000`)
   - `HOST`: API host interface (default: `0.0.0.0`)
   - `NODE_ENV`: Runtime environment (`development`, `test`, `production`)
   - `LOG_LEVEL`: Pino logger level (`debug`, `info`, `warn`, `error`)
   - `CORS_ORIGIN`: Allowed origins for CORS (default: `http://localhost:5173`)
   - `DATABASE_URL`: PostgreSQL connection string (e.g. `postgresql://localhost:5433/devdocs_ai`)
   - `TEST_DATABASE_URL`: Test database connection string (e.g. `postgresql://localhost:5433/devdocs_ai_test`)

---

## 3. Database Setup & Migrations

### Option A: Local Postgres.app with pgvector (macOS)
```bash
# Ensure devdocs_ai and devdocs_ai_test databases exist
psql -h localhost -p 5433 -d postgres -c "CREATE DATABASE devdocs_ai;"
psql -h localhost -p 5433 -d postgres -c "CREATE DATABASE devdocs_ai_test;"
```

### Option B: Docker Compose (All Platforms)
```bash
docker compose up -d
```

### Database Migration Commands
```bash
# Check current migration status
npm run db:status

# Apply pending migrations
npm run db:migrate

# Reset local database (drops schema public, reapplies all migrations from scratch)
# CRITICAL SAFETY: Deletes all data in the target database!
# Strictly requires NODE_ENV=development and ALLOW_DB_RESET=true.
# Refuses execution without ALLOW_DB_RESET=true or if target appears to be production.
ALLOW_DB_RESET=true npm run db:reset
```

### Test Database Isolation
Automated integration tests require a dedicated test database:
- Configured via `TEST_DATABASE_URL` (default: `postgresql://localhost:5433/devdocs_ai_test`).
- The test database name **must end with `_test`**.
- Tests strictly refuse to run if `TEST_DATABASE_URL` targets the same host, port, and database name as application `DATABASE_URL`.

---

## 4. Installation

Install all dependencies across the monorepo:
```bash
npm install
```

---

## 5. Running the Development Environment

Start both the Fastify API server and the Vite React frontend concurrently:
```bash
npm run dev
```

Or run services individually in dedicated terminals:
- **API Server** (`http://localhost:4000`):
  ```bash
  npm run dev:api
  ```
- **Web Frontend** (`http://localhost:5173`):
  ```bash
  npm run dev:web
  ```

---

## 6. Verification Commands

Run the full verification suite:

```bash
# Typecheck all packages
npm run typecheck

# Run test suites across packages (shared, api, db)
npm run test

# Build production artifacts
npm run build

# Run linting across packages
npm run lint

# Audit dependencies for known vulnerabilities
npm audit
```

---

## 7. Probing the Health Endpoint

Once the API server is running, probe the health endpoints:

```bash
# Main application health
curl -s http://localhost:4000/health | jq

# Liveness probe
curl -s http://localhost:4000/health/live | jq

# Readiness probe
curl -s http://localhost:4000/health/ready | jq
```
