# Database Migrations

This directory contains versioned SQL migrations for DevDocs AI.

## Architecture & Conventions (Instruction 02+)

1. **Naming Standard**: Sequential numbering with descriptive snake_case names:
   - `001_initial_schema.sql`
   - `002_pgvector_indexes.sql`
   - `003_rbac_and_organizations.sql`

2. **Source of Truth**: Plain SQL migrations executed against PostgreSQL. We prefer straightforward SQL migrations over opaque ORM schema magic to ensure full control over `pgvector` indexing (`HNSW`, `ivfflat`), GIN full-text search indexes, and multi-tenant constraints.

3. **Status**: Placeholder directory established during Instruction 01 bootstrap. Actual schema and migration runner are scheduled for Instruction 02.
