# Database Migrations

This directory contains versioned SQL migrations for DevDocs AI.

## Architecture & Conventions

1. **Naming Standard**: Sequential numbering with descriptive snake_case names:
   - `001_enable_pgvector.sql`: Enables `uuid-ossp` and `vector` extensions.
   - `002_create_initial_schema.sql`: Core relational multi-tenant schema with 12 domain tables, pgvector `vector(1536)` embeddings, HNSW index, GIN full-text search index, and integrity constraints.

2. **Source of Truth**: Plain SQL migrations executed against PostgreSQL. We prefer straightforward SQL migrations over opaque ORM schema magic to ensure full control over `pgvector` indexing (`HNSW` cosine similarity), GIN full-text search indexes (`tsvector`), and multi-tenant constraints.

3. **Tracking**: Migrations are tracked durably in the `schema_migrations` table (`version`, `name`, `applied_at`).

## CLI Commands

- `npm run db:status`: View current migration status and application timestamps.
- `npm run db:migrate`: Execute all unapplied migrations in transactional order.
- `ALLOW_DB_RESET=true npm run db:reset`: Development-only command that drops and recreates the public schema, then reapplies all migrations from scratch. (Requires NODE_ENV=development and ALLOW_DB_RESET=true; strictly prohibited in production and against unverified targets).
