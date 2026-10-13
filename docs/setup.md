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
   - `JWT_SECRET`: Secret key for signing JWT access tokens (minimum 32 characters in production)
   - `MAX_FILE_SIZE_BYTES`: Maximum document upload size in bytes (default: `10485760` = 10MB)
   - `EMBEDDING_PROVIDER`: Embedding provider adapter (`openai` or `mock`, default: `openai`)
   - `OPENAI_API_KEY`: OpenAI API key (required when `EMBEDDING_PROVIDER=openai`)
   - `OPENAI_EMBEDDING_MODEL`: Embedding model name (default: `text-embedding-3-small`)
   - `EMBEDDING_DIMENSIONS`: Output vector dimensions (default: `1536`)
   - `CHUNK_SIZE_CHARS`: Chunking target size in characters (default: `800`)
   - `CHUNK_OVERLAP_CHARS`: Overlap between adjacent chunks in characters (default: `120`)
   - `EMBEDDING_BATCH_SIZE`: Batch size for embedding API calls (default: `100`)
   - `EMBEDDING_TIMEOUT_MS`: Embeddings request timeout in milliseconds (default: `30000`)

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

---

## 8. Manual Testing (Auth & Organizations)

Once the API server is running, you can test the Phase 3 authentication and RBAC workflows using `curl`:

```bash
# 1. Register a new user
curl -s -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq

# 2. Login to obtain a JWT token
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq -r .token)

# 3. Retrieve current authenticated user profile
curl -s http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq

# 4. Create an organization workspace (caller becomes Admin)
ORG_ID=$(curl -s -X POST http://localhost:4000/api/organizations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Engineering"}' | jq -r .organization.id)

# 5. List your organizations
curl -s http://localhost:4000/api/organizations \
  -H "Authorization: Bearer $TOKEN" | jq

# 6. Revoke token via logout
curl -s -X POST http://localhost:4000/api/auth/logout \
  -H "Authorization: Bearer $TOKEN" | jq

# 7. Verify revoked token is now rejected (returns 401 TOKEN_REVOKED)
curl -s http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## 9. Manual Testing (Document Upload & Parsing)

Test Phase 4 document upload, validation, parsing, and lifecycle endpoints using `curl`:

```bash
# 1. Login to get a valid token
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"Password123!"}' | jq -r .token)

# 2. Get your organization ID
ORG_ID=$(curl -s http://localhost:4000/api/organizations \
  -H "Authorization: Bearer $TOKEN" | jq -r '.organizations[0].id')

# 3. Upload a Markdown document (multipart/form-data)
DOC=$(curl -s -X POST http://localhost:4000/api/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@README.md" \
  -F "organizationId=$ORG_ID")
echo "$DOC" | jq
DOC_ID=$(echo "$DOC" | jq -r '.document.id')

# 4. Duplicate upload attempt (returns 409 DUPLICATE_DOCUMENT with existing doc ID)
curl -s -X POST http://localhost:4000/api/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@README.md" \
  -F "organizationId=$ORG_ID" | jq

# 5. List organization documents with pagination and sorting
curl -s "http://localhost:4000/api/documents?organizationId=$ORG_ID&limit=10&page=1" \
  -H "Authorization: Bearer $TOKEN" | jq

# 6. Retrieve document details (including version, pages, sections, and metrics)
curl -s "http://localhost:4000/api/documents/$DOC_ID?organizationId=$ORG_ID" \
  -H "Authorization: Bearer $TOKEN" | jq

# 7. Delete document (Admin only)
curl -s -X DELETE "http://localhost:4000/api/documents/$DOC_ID?organizationId=$ORG_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```
