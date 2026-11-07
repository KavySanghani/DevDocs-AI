-- Migration: 006_add_citation_metadata
-- Description: Add metadata column to citations table for code citations and repository provenance

ALTER TABLE citations
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
