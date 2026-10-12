-- Migration: 002_create_initial_schema
-- Description: Core relational schema for DevDocs AI multi-tenant architecture

-- -----------------------------------------------------------------------------
-- 1. Users
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    account_status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT chk_users_account_status CHECK (account_status IN ('active', 'suspended', 'deactivated'))
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_account_status ON users(account_status);

-- -----------------------------------------------------------------------------
-- 2. Organizations (Tenant boundary)
-- -----------------------------------------------------------------------------
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_organizations_slug UNIQUE (slug)
);

CREATE INDEX idx_organizations_slug ON organizations(slug);

-- -----------------------------------------------------------------------------
-- 3. Organization Members (Tenant-scoped RBAC)
-- -----------------------------------------------------------------------------
CREATE TABLE organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_org_members_org_user UNIQUE (organization_id, user_id),
    CONSTRAINT chk_org_members_role CHECK (role IN ('admin', 'member', 'viewer'))
);

CREATE INDEX idx_org_members_user_id ON organization_members(user_id);
CREATE INDEX idx_org_members_org_role ON organization_members(organization_id, role);

-- -----------------------------------------------------------------------------
-- 4. Documents (Logical document entity)
-- -----------------------------------------------------------------------------
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    current_version_id UUID, -- Circular FK added after document_versions table creation
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_documents_source_type CHECK (source_type IN ('pdf', 'markdown', 'text', 'github'))
);

CREATE INDEX idx_documents_org_id ON documents(organization_id);
CREATE INDEX idx_documents_created_by ON documents(created_by);
CREATE INDEX idx_documents_source_type ON documents(organization_id, source_type);

-- -----------------------------------------------------------------------------
-- 5. Document Versions (Immutable versions)
-- -----------------------------------------------------------------------------
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    source_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_doc_versions_doc_version UNIQUE (document_id, version_number),
    CONSTRAINT chk_doc_versions_version_number CHECK (version_number > 0),
    CONSTRAINT chk_doc_versions_status CHECK (status IN ('queued', 'processing', 'ready', 'failed'))
);

CREATE INDEX idx_doc_versions_doc_id ON document_versions(document_id);
CREATE INDEX idx_doc_versions_status ON document_versions(status);
CREATE INDEX idx_doc_versions_hash ON document_versions(content_hash);

-- Circular foreign key from documents to document_versions
ALTER TABLE documents
    ADD CONSTRAINT fk_documents_current_version
    FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 6. Chunks (Search units with pgvector embeddings and lexical search vector)
-- -----------------------------------------------------------------------------
CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536),
    token_count INT,
    character_count INT,
    page_number INT,
    section_title VARCHAR(255),
    file_path TEXT,
    line_start INT,
    line_end INT,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_chunks_version_index UNIQUE (document_version_id, chunk_index),
    CONSTRAINT chk_chunks_index CHECK (chunk_index >= 0)
);

CREATE INDEX idx_chunks_version_id ON chunks(document_version_id);
CREATE INDEX idx_chunks_search_vector ON chunks USING GIN(search_vector);
CREATE INDEX idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- 7. Chat Sessions
-- -----------------------------------------------------------------------------
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_sessions_org_user ON chat_sessions(organization_id, user_id);
CREATE INDEX idx_chat_sessions_created_at ON chat_sessions(created_at DESC);

-- -----------------------------------------------------------------------------
-- 8. Messages
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    retrieval_run_id UUID, -- Added after retrieval_runs table creation
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_messages_role CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_created_at ON messages(session_id, created_at ASC);

-- -----------------------------------------------------------------------------
-- 9. Retrieval Runs
-- -----------------------------------------------------------------------------
CREATE TABLE retrieval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    query TEXT NOT NULL,
    rewritten_query TEXT,
    retriever VARCHAR(100) NOT NULL DEFAULT 'hybrid',
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
    latency_ms INT,
    candidate_count INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_retrieval_runs_org_id ON retrieval_runs(organization_id);
CREATE INDEX idx_retrieval_runs_message_id ON retrieval_runs(message_id);

-- Link messages to retrieval_runs
ALTER TABLE messages
    ADD CONSTRAINT fk_messages_retrieval_run
    FOREIGN KEY (retrieval_run_id) REFERENCES retrieval_runs(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 10. Retrieval Results (Candidate provenance)
-- -----------------------------------------------------------------------------
CREATE TABLE retrieval_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retrieval_run_id UUID NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
    chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    rank INT NOT NULL,
    score DOUBLE PRECISION NOT NULL,
    retriever_name VARCHAR(100) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_retrieval_results_rank CHECK (rank >= 0)
);

CREATE INDEX idx_retrieval_results_run_rank ON retrieval_results(retrieval_run_id, rank);
CREATE INDEX idx_retrieval_results_chunk_id ON retrieval_results(chunk_id);

-- -----------------------------------------------------------------------------
-- 11. Feedback
-- -----------------------------------------------------------------------------
CREATE TABLE feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    rating VARCHAR(20) NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_feedback_rating CHECK (rating IN ('helpful', 'unhelpful'))
);

CREATE INDEX idx_feedback_message_id ON feedback(message_id);
CREATE INDEX idx_feedback_user_id ON feedback(user_id);

-- -----------------------------------------------------------------------------
-- 12. Jobs (Durable ingestion & import status tracking with tenant idempotency)
-- -----------------------------------------------------------------------------
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type VARCHAR(100) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    error_summary TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_jobs_org_idempotency UNIQUE (organization_id, idempotency_key),
    CONSTRAINT chk_jobs_type CHECK (type IN ('document_ingestion', 'repo_import', 'document_reindex', 'document_deletion')),
    CONSTRAINT chk_jobs_status CHECK (status IN ('queued', 'processing', 'retrying', 'ready', 'failed')),
    CONSTRAINT chk_jobs_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_jobs_max_attempts CHECK (max_attempts > 0)
);

CREATE INDEX idx_jobs_org_status ON jobs(organization_id, status);
CREATE INDEX idx_jobs_created_at ON jobs(created_at ASC);

-- -----------------------------------------------------------------------------
-- Automatic updated_at Trigger Function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_organization_members_updated_at BEFORE UPDATE ON organization_members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_document_versions_updated_at BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_chat_sessions_updated_at BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
