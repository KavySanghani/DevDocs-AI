import crypto from 'node:crypto';
import { Worker, type Job, UnrecoverableError } from 'bullmq';
import { query } from '@devdocs/db';
import { getRedisConnection } from './connection.js';
import { INGESTION_QUEUE_NAME, type IngestionJobData } from './ingestionQueue.js';
import {
  claimJobLease,
  renewJobLease,
  releaseJobFailure,
  getJobRecord,
  updateJobStatus,
  LeaseFencingError,
} from '../jobs/jobService.js';
import { ingestDocumentVersion } from '../ingestion/index.js';
import type { EmbeddingProvider } from '../ingestion/types.js';
import { getEnv } from '../../config/env.js';

let ingestionWorker: Worker<IngestionJobData> | null = null;

/**
 * Determines whether an error is transient (eligible for retry with backoff)
 * or permanent (immediate terminal failure without retrying).
 */
export function isTransientError(err: unknown): boolean {
  if (!err) return false;

  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;
  const statusCode = (err as { statusCode?: number })?.statusCode;

  // Rate limiting or 5xx server errors from providers
  if (statusCode === 429 || (statusCode && statusCode >= 500 && statusCode < 600)) {
    return true;
  }

  // Common network and connection errors
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }

  // String matching for provider timeouts / rate limits
  if (
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('temporarily unavailable') ||
    msg.toLowerCase().includes('gateway')
  ) {
    return true;
  }

  // Permanent business, parsing, or validation errors
  return false;
}

export interface ProcessIngestionOptions {
  overrideProvider?: EmbeddingProvider | undefined;
  workerId?: string | undefined;
  leaseDurationSeconds?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  skipHeartbeat?: boolean | undefined;
}

/**
 * Core processor for document ingestion jobs.
 * Used both by the BullMQ Worker and directly for outbox recovery / deterministic testing.
 * Enforces distributed lease ownership, periodic heartbeats, and fencing tokens to prevent split-brain overwrites.
 */
export async function processIngestionJobDirectly(
  data: IngestionJobData,
  optionsOrProvider?: EmbeddingProvider | ProcessIngestionOptions
): Promise<{ success: boolean; chunkCount: number; versionId: string }> {
  const options: ProcessIngestionOptions =
    optionsOrProvider && 'embedChunks' in optionsOrProvider
      ? { overrideProvider: optionsOrProvider as EmbeddingProvider }
      : ((optionsOrProvider as ProcessIngestionOptions) ?? {});

  const { jobId, documentId, versionId, organizationId, config } = data;
  const overrideProvider = options.overrideProvider;

  // 1. Load authoritative database state from PostgreSQL (never trust raw payload alone)
  const dbJob = await getJobRecord(jobId);
  if (!dbJob) {
    throw new UnrecoverableError(`Job ${jobId} does not exist in PostgreSQL jobs table.`);
  }

  // Tenant Boundary Check: verify document belongs to the job's organization
  const docRes = await query<{ id: string; organization_id: string; current_version_id: string | null }>(
    'SELECT id, organization_id, current_version_id FROM documents WHERE id = $1',
    [documentId]
  );
  const doc = docRes.rows[0];
  if (!doc || doc.organization_id !== organizationId || doc.organization_id !== dbJob.organization_id) {
    const errorMsg = 'Cross-tenant violation: document does not belong to authorized organization';
    await updateJobStatus(jobId, {
      status: 'failed',
      errorSummary: errorMsg,
      stage: 'validation',
    });
    throw new UnrecoverableError(errorMsg);
  }

  // Idempotency: if job is already marked 'ready' in PostgreSQL, skip duplicate processing
  if (dbJob.status === 'ready') {
    return {
      success: true,
      chunkCount: Number(dbJob.payload?.chunkCount ?? 0),
      versionId,
    };
  }

  // 2. Atomically claim or reclaim the lease with an incremented fencing token
  const workerId = options.workerId ?? `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const leaseSeconds = options.leaseDurationSeconds ?? 30;

  const claim = await claimJobLease({
    jobId,
    workerId,
    leaseDurationSeconds: leaseSeconds,
  });

  if (!claim.success) {
    if (claim.reason === 'already_ready') {
      return {
        success: true,
        chunkCount: Number(claim.job?.payload?.chunkCount ?? 0),
        versionId,
      };
    }
    throw new Error(`Cannot claim job ${jobId}: ${claim.reason}`);
  }

  const fencingToken = claim.fencingToken!;
  const currentAttempts = claim.job!.attempts;

  // 3. Start background lease heartbeat timer
  let isLeaseLost = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  if (!options.skipHeartbeat) {
    const heartbeatMs = options.heartbeatIntervalMs ?? 5000;
    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await renewJobLease({
          jobId,
          workerId,
          fencingToken,
          leaseDurationSeconds: leaseSeconds,
        });
        if (!renewed) {
          isLeaseLost = true;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      } catch {
        // Transient network issue connecting to database
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  try {
    if (isLeaseLost) {
      throw new LeaseFencingError(`Worker lease was lost for job ${jobId}; aborting before chunk commit.`);
    }

    // 4. Run the ingestion pipeline (chunking + embeddings + vector storage)
    // SEC-10-02: Pass fencingContext ({ jobId, workerId, fencingToken }) so that chunk deletion,
    // chunk insertion, version status update ('ready'), job status update ('ready'), and monotonic
    // current_version_id activation are all executed in ONE single transaction under SELECT ... FOR UPDATE.
    const ingestRes = await ingestDocumentVersion({
      documentId,
      documentVersionId: versionId,
      organizationId,
      fencingContext: {
        jobId,
        workerId,
        fencingToken,
      },
      ...(config ? { config } : {}),
      ...(overrideProvider ? { provider: overrideProvider } : {}),
    });

    return {
      success: true,
      chunkCount: ingestRes.chunkCount,
      versionId,
    };
  } catch (err) {
    if (err instanceof LeaseFencingError) {
      // SEC-10-01 / SEC-10-02:
      // The worker lost its lease or fencing ownership during persistence (or was superseded).
      // A stale worker that lost ownership MUST NOT touch jobs or document_versions.
      throw new UnrecoverableError(err.message);
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    const transient = isTransientError(err);

    if (transient && currentAttempts < claim.job!.max_attempts) {
      // Mark as retrying with backoff details and release lease
      const released = await releaseJobFailure({
        jobId,
        workerId,
        fencingToken,
        newStatus: 'retrying',
        errorSummary: `[Attempt ${currentAttempts}/${claim.job!.max_attempts}] ${errorMsg}`,
        stage: 'retry_backoff',
      });
      if (!released) {
        // Lost lease/fencing token before/during failure handling
        throw new UnrecoverableError(
          `Worker lost ownership or fencing token for job ${jobId} during retryable failure.`
        );
      }
      // Re-throw so BullMQ schedules exponential backoff retry
      throw err;
    } else {
      // Permanent error or attempts exhausted: record terminal failure in both jobs and document_versions
      // SEC-10-01: releaseJobFailure verifies workerId and fencingToken atomically,
      // and only updates document_versions if this worker STILL holds authoritative ownership
      // AND document_versions.status != 'ready'.
      const released = await releaseJobFailure({
        jobId,
        workerId,
        fencingToken,
        newStatus: 'failed',
        errorSummary: errorMsg,
        stage: 'failed',
        documentVersionId: versionId,
      });

      if (!released) {
        // Worker was stale and lost ownership; do not touch anything else
        throw new UnrecoverableError(
          `Worker lost ownership or fencing token for job ${jobId}; suppressing failure update.`
        );
      }

      // Tell BullMQ not to retry unrecoverable/exhausted errors
      throw new UnrecoverableError(errorMsg);
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

/**
 * Initializes and starts the BullMQ background worker.
 */
export function startIngestionWorker(options?: {
  concurrency?: number;
  overrideProvider?: EmbeddingProvider;
}): Worker<IngestionJobData> {
  if (ingestionWorker) {
    return ingestionWorker;
  }

  const env = getEnv();
  const redis = getRedisConnection();
  const concurrency = options?.concurrency ?? env.WORKER_CONCURRENCY ?? 5;

  ingestionWorker = new Worker<IngestionJobData>(
    INGESTION_QUEUE_NAME,
    async (job: Job<IngestionJobData>) => {
      return processIngestionJobDirectly(
        job.data,
        options?.overrideProvider ? { overrideProvider: options.overrideProvider } : undefined
      );
    },
    {
      connection: redis,
      concurrency,
    }
  );

  ingestionWorker.on('completed', (job) => {
    // Stage progress observable without logging sensitive text
    console.log(`[Worker] Job ${job.id} completed successfully (doc: ${job.data.documentId})`);
  });

  ingestionWorker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
  });

  ingestionWorker.on('error', (err) => {
    console.error(`[Worker Error]: ${err.message}`);
  });

  return ingestionWorker;
}

/**
 * Gracefully shuts down the BullMQ worker.
 */
export async function closeIngestionWorker(): Promise<void> {
  if (ingestionWorker) {
    try {
      await ingestionWorker.close();
    } finally {
      ingestionWorker = null;
    }
  }
}
