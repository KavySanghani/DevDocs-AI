-- Migration: 004_create_citations
-- Description: Store validated citation records linked to assistant messages and retrieved chunks

CREATE TABLE citations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL,
    citation_number INT NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    document_name VARCHAR(255) NOT NULL,
    page_number INT,
    section_title VARCHAR(255),
    file_path TEXT,
    line_start INT,
    line_end INT,
    snippet TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_citations_message_number UNIQUE (message_id, citation_number),
    CONSTRAINT chk_citations_number CHECK (citation_number > 0)
);

CREATE INDEX idx_citations_message_id ON citations(message_id);
CREATE INDEX idx_citations_chunk_id ON citations(chunk_id);
CREATE INDEX idx_citations_document_id ON citations(document_id);
