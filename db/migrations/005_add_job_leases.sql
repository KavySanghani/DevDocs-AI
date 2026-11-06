-- Migration: 005_add_job_leases
-- Description: Add distributed lease tracking, worker heartbeats, and fencing tokens to jobs table

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS locked_by VARCHAR(255),
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fencing_token INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_jobs_status_locked_until ON jobs(status, locked_until);
