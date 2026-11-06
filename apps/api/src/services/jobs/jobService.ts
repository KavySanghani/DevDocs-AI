import { query, withTransaction } from '@devdocs/db';
import type { JobResponse, JobStatus, JobType } from '@devdocs/shared';
import { getOrganizationMember } from '../organizationService.js';

export class LeaseFencingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseFencingError';
    Object.setPrototypeOf(this, LeaseFencingError.prototype);
  }
}

export interface JobFencingContext {
  jobId: string;
  workerId: string;
  fencingToken: number;
}

export class JobError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code: string = 'BAD_REQUEST',
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'JobError';
    Object.setPrototypeOf(this, JobError.prototype);
  }
}

export interface DbJobRow {
  id: string;
  organization_id: string;
  type: JobType;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  error_summary: string | null;
  payload: Record<string, unknown>;
  locked_by: string | null;
  locked_until: Date | null;
  fencing_token: number;
  created_at: Date;
  updated_at: Date;
}

export function formatJobResponse(row: DbJobRow): JobResponse {
  const payload = row.payload ?? {};
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorSummary: row.error_summary,
    stage: typeof payload.stage === 'string' ? payload.stage : undefined,
    documentId: typeof payload.documentId === 'string' ? payload.documentId : undefined,
    versionId: typeof payload.versionId === 'string' ? payload.versionId : undefined,
    payload,
    lockedBy: row.locked_by ?? undefined,
    lockedUntil: row.locked_until ? row.locked_until.toISOString() : undefined,
    fencingToken: row.fencing_token,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Creates or retrieves an existing durable job using tenant-scoped idempotency key.
 * Guarantees race-safe concurrency: exactly one request receives isNew: true under concurrent submissions.
 */
export async function createJob(params: {
  organizationId: string;
  type: JobType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<{ job: JobResponse; isNew: boolean }> {
  const { organizationId, type, idempotencyKey, payload, maxAttempts = 3 } = params;

  // 1. Fast-path check if job already exists with this idempotency key in this organization
  const existingRes = await query<DbJobRow>(
    `SELECT id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at
     FROM jobs
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey]
  );

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0]!;
    return { job: formatJobResponse(existing), isNew: false };
  }

  // 2. Atomic insert with ON CONFLICT DO NOTHING to eliminate race conditions
  const insertRes = await query<DbJobRow>(
    `INSERT INTO jobs (organization_id, type, idempotency_key, status, attempts, max_attempts, payload)
     VALUES ($1, $2, $3, 'queued', 0, $4, $5)
     ON CONFLICT (organization_id, idempotency_key)
     DO NOTHING
     RETURNING id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at`,
    [organizationId, type, idempotencyKey, maxAttempts, JSON.stringify(payload)]
  );

  if (insertRes.rows.length > 0) {
    const row = insertRes.rows[0]!;
    return { job: formatJobResponse(row), isNew: true };
  }

  // 3. Conflict occurred during concurrent insertion: fetch the winning record
  const conflictRes = await query<DbJobRow>(
    `SELECT id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at
     FROM jobs
     WHERE organization_id = $1 AND idempotency_key = $2`,
    [organizationId, idempotencyKey]
  );

  const winningRow = conflictRes.rows[0]!;
  return { job: formatJobResponse(winningRow), isNew: false };
}

/**
 * Retrieves a job record with tenant isolation and authorization checks.
 */
export async function getJobById(jobId: string, callerUserId: string): Promise<JobResponse> {
  const res = await query<DbJobRow>(
    `SELECT id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at
     FROM jobs
     WHERE id = $1`,
    [jobId]
  );

  const jobRow = res.rows[0];
  if (!jobRow) {
    throw new JobError('Job not found or access denied', 404, 'JOB_NOT_FOUND');
  }

  // Enforce server-side tenant RBAC: caller must be a member of the organization that owns this job
  const member = await getOrganizationMember(jobRow.organization_id, callerUserId);
  if (!member) {
    throw new JobError('Job not found or access denied', 404, 'JOB_NOT_FOUND');
  }

  return formatJobResponse(jobRow);
}

/**
 * Internal worker helper to fetch a raw job record by ID.
 */
export async function getJobRecord(jobId: string): Promise<DbJobRow | null> {
  const res = await query<DbJobRow>(
    `SELECT id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at
     FROM jobs
     WHERE id = $1`,
    [jobId]
  );
  return res.rows[0] ?? null;
}

/**
 * Atomically attempts to claim or reclaim a job lease with an incremented fencing token.
 * Prevents split-brain worker execution and stale processing overlaps.
 */
export async function claimJobLease(params: {
  jobId: string;
  workerId: string;
  leaseDurationSeconds?: number | undefined;
}): Promise<{
  success: boolean;
  job?: DbJobRow | undefined;
  fencingToken?: number | undefined;
  reason?: 'already_ready' | 'already_locked' | 'not_found' | undefined;
}> {
  const { jobId, workerId, leaseDurationSeconds = 30 } = params;

  // 1. Check if job exists and if already ready
  const current = await getJobRecord(jobId);
  if (!current) {
    return { success: false, reason: 'not_found' };
  }
  if (current.status === 'ready') {
    return { success: false, job: current, reason: 'already_ready' };
  }

  // 2. Atomically attempt to acquire the lease.
  // Conditions to claim:
  // - status IN ('queued', 'retrying')
  // - OR status = 'processing' AND (locked_until IS NULL OR locked_until < now())
  const res = await query<DbJobRow>(
    `UPDATE jobs
     SET status = 'processing',
         attempts = attempts + 1,
         locked_by = $1,
         locked_until = now() + ($2 || ' seconds')::interval,
         fencing_token = fencing_token + 1,
         updated_at = now()
     WHERE id = $3
       AND (
         status IN ('queued', 'retrying')
         OR (status = 'processing' AND (locked_until IS NULL OR locked_until < now()))
       )
     RETURNING id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at`,
    [workerId, leaseDurationSeconds, jobId]
  );

  if (res.rows.length === 0) {
    const latest = await getJobRecord(jobId);
    if (latest?.status === 'ready') {
      return { success: false, job: latest, reason: 'already_ready' };
    }
    return { success: false, job: latest ?? undefined, reason: 'already_locked' };
  }

  const updatedJob = res.rows[0]!;
  return {
    success: true,
    job: updatedJob,
    fencingToken: updatedJob.fencing_token,
  };
}

/**
 * Extends the lease of an actively processing job via periodic heartbeat.
 * Returns false if the worker has lost ownership or the fencing token was superseded.
 */
export async function renewJobLease(params: {
  jobId: string;
  workerId: string;
  fencingToken: number;
  leaseDurationSeconds?: number;
}): Promise<boolean> {
  const { jobId, workerId, fencingToken, leaseDurationSeconds = 30 } = params;

  const res = await query<{ id: string }>(
    `UPDATE jobs
     SET locked_until = now() + ($1 || ' seconds')::interval,
         updated_at = now()
     WHERE id = $2
       AND locked_by = $3
       AND fencing_token = $4
       AND status = 'processing'`,
    [leaseDurationSeconds, jobId, workerId, fencingToken]
  );

  return (res.rowCount ?? 0) > 0;
}

/**
 * Atomically marks a job as 'ready' and clears the lease, ensuring the caller
 * still holds the authoritative fencing token and ownership.
 */
export async function finalizeJobSuccess(params: {
  jobId: string;
  workerId: string;
  fencingToken: number;
  payloadUpdates?: Record<string, unknown>;
}): Promise<boolean> {
  const { jobId, workerId, fencingToken, payloadUpdates } = params;

  const current = await getJobRecord(jobId);
  if (!current) return false;

  const mergedPayload: Record<string, unknown> = {
    ...current.payload,
    ...(payloadUpdates ?? {}),
    stage: 'completed',
  };

  const res = await query<{ id: string }>(
    `UPDATE jobs
     SET status = 'ready',
         locked_by = NULL,
         locked_until = NULL,
         error_summary = NULL,
         payload = $1,
         updated_at = now()
     WHERE id = $2
       AND locked_by = $3
       AND fencing_token = $4
       AND status = 'processing'`,
    [JSON.stringify(mergedPayload), jobId, workerId, fencingToken]
  );

  return (res.rowCount ?? 0) > 0;
}

/**
 * Releases worker ownership upon failure, transitioning to 'retrying' or 'failed'.
 * SEC-10-01: Validates that the worker still holds authoritative ownership and fencing token.
 * If newStatus is 'failed' and documentVersionId is provided, updates the document_versions table
 * within the same transaction, ensuring stale workers cannot corrupt document-version state,
 * and never overwriting a version that was already marked 'ready'.
 */
export async function releaseJobFailure(params: {
  jobId: string;
  workerId: string;
  fencingToken: number;
  newStatus: 'retrying' | 'failed';
  errorSummary: string | null;
  stage?: string;
  documentVersionId?: string;
}): Promise<boolean> {
  const { jobId, workerId, fencingToken, newStatus, errorSummary, stage, documentVersionId } = params;

  return await withTransaction(async (client) => {
    // 1. Lock job row and verify worker ownership, fencing token, and unexpired lease
    const jobRes = await client.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload
       FROM jobs
       WHERE id = $1
         AND locked_by = $2
         AND fencing_token = $3
         AND status = 'processing'
         AND locked_until > now()
       FOR UPDATE`,
      [jobId, workerId, fencingToken]
    );

    if (jobRes.rows.length === 0) {
      return false;
    }

    const currentPayload = jobRes.rows[0]?.payload ?? {};
    const mergedPayload: Record<string, unknown> = {
      ...currentPayload,
      ...(stage ? { stage } : {}),
    };

    // 2. Transition job to retrying or failed
    await client.query(
      `UPDATE jobs
       SET status = $1,
           locked_by = NULL,
           locked_until = NULL,
           error_summary = $2,
           payload = $3,
           updated_at = now()
       WHERE id = $4`,
      [newStatus, errorSummary, JSON.stringify(mergedPayload), jobId]
    );

    // 3. SEC-10-01: If permanent failure and documentVersionId is provided,
    // mark version failed ONLY within the same transaction and NEVER if status is 'ready'
    if (newStatus === 'failed' && documentVersionId) {
      await client.query(
        `UPDATE document_versions
         SET status = 'failed',
             error_message = $1,
             updated_at = now()
         WHERE id = $2 AND status != 'ready'`,
        [errorSummary, documentVersionId]
      );
    }

    return true;
  });
}

/**
 * Updates status, progress stage, attempts, and error details of a job.
 */
export async function updateJobStatus(
  jobId: string,
  updates: {
    status?: JobStatus;
    attempts?: number;
    errorSummary?: string | null;
    stage?: string;
    payloadUpdates?: Record<string, unknown>;
  }
): Promise<JobResponse> {
  const current = await getJobRecord(jobId);
  if (!current) {
    throw new JobError(`Job ${jobId} not found`, 404, 'JOB_NOT_FOUND');
  }

  const mergedPayload: Record<string, unknown> = {
    ...current.payload,
    ...(updates.payloadUpdates ?? {}),
    ...(updates.stage ? { stage: updates.stage } : {}),
  };

  const newStatus = updates.status ?? current.status;
  const newAttempts = updates.attempts !== undefined ? updates.attempts : current.attempts;
  const newError = updates.errorSummary !== undefined ? updates.errorSummary : current.error_summary;

  const res = await query<DbJobRow>(
    `UPDATE jobs
     SET status = $1,
         attempts = $2,
         error_summary = $3,
         payload = $4,
         updated_at = now()
     WHERE id = $5
     RETURNING id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at`,
    [newStatus, newAttempts, newError, JSON.stringify(mergedPayload), jobId]
  );

  return formatJobResponse(res.rows[0]!);
}

/**
 * Finds eligible queued, retrying, or genuinely stale processing jobs for recovery.
 * Recovers processing jobs ONLY if their lease has expired (locked_until < now()).
 */
export async function getRecoverableJobs(criteria?: {
  olderThanSeconds?: number;
  staleProcessingSeconds?: number;
  limit?: number;
}): Promise<DbJobRow[]> {
  const olderThanSeconds = criteria?.olderThanSeconds ?? 30;
  const staleProcessingSeconds = criteria?.staleProcessingSeconds ?? 60;
  const limit = criteria?.limit ?? 50;

  const res = await query<DbJobRow>(
    `SELECT id, organization_id, type, idempotency_key, status, attempts, max_attempts, error_summary, payload, locked_by, locked_until, fencing_token, created_at, updated_at
     FROM jobs
     WHERE (
       status IN ('queued', 'retrying')
       AND updated_at <= now() - ($1 || ' seconds')::interval
     ) OR (
       status = 'processing'
       AND (locked_until IS NULL OR locked_until < now())
       AND updated_at <= now() - ($2 || ' seconds')::interval
     )
     ORDER BY created_at ASC
     LIMIT $3`,
    [olderThanSeconds, staleProcessingSeconds, limit]
  );

  return res.rows;
}

/**
 * Backward compatibility alias for finding recoverable queued/retrying/stale-processing jobs.
 */
export async function getRecoverableQueuedJobs(olderThanSeconds = 30, limit = 50): Promise<DbJobRow[]> {
  return getRecoverableJobs({ olderThanSeconds, staleProcessingSeconds: olderThanSeconds, limit });
}
