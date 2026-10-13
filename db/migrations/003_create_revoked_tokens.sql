-- Migration: 003_create_revoked_tokens
-- Description: Token revocation denylist table for explicit JWT logout & security invalidation

CREATE TABLE revoked_tokens (
    jti VARCHAR(255) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_revoked_tokens_expires_at ON revoked_tokens(expires_at);
CREATE INDEX idx_revoked_tokens_user_id ON revoked_tokens(user_id);
