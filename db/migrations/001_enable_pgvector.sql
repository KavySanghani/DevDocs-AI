-- Migration: 001_enable_pgvector
-- Description: Enable pgvector and uuid extensions for vector embeddings and unique identifiers

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
