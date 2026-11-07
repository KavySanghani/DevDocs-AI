import { query } from '@devdocs/db';
import { getRecoverableJobs, updateJobStatus } from '../jobs/jobService.js';
import { enqueueIngestionJob, type IngestionJobData } from './ingestionQueue.js';
import { processIngestionJobDirectly } from './ingestionWorker.js';
import type { EmbeddingProvider } from '../ingestion/types.js';

export interface RecoveryResult {
  scanned: number;
  recovered: number;
  exhausted: number;
  errors: number;
}

let periodicRecoveryTimer: NodeJS.Timeout | null = null;
let isPeriodicScanning = false;

/**
 * Scans PostgreSQL for jobs in 'queued', 'retrying', or genuinely stale 'processing' status
 * (whose lease has expired) due to Redis downtime or worker restarts, and safely re-enqueues
 * or processes them.
 */
export async function recoverStuckQueuedJobs(options?: {
  olderThanSeconds?: number;
  staleProcessingSeconds?: number;
  limit?: number;
  processDirectly?: boolean;
  provider?: EmbeddingProvider;
}): Promise<RecoveryResult> {
  const olderThanSeconds = options?.olderThanSeconds ?? 30;
  const staleProcessingSeconds = options?.staleProcessingSeconds ?? 60;
  const limit = options?.limit ?? 50;

  const stuckJobs = await getRecoverableJobs({
    olderThanSeconds,
    staleProcessingSeconds,
    limit,
  });

  let recovered = 0;
  let exhausted = 0;
  let errors = 0;

  for (const job of stuckJobs) {
    const payload = job.payload ?? {};
    const documentId = payload.documentId as string | undefined;
    const versionId = payload.versionId as string | undefined;

    if (!documentId || !versionId) {
      continue;
    }

    // Check if a stale processing job has already exhausted its attempts
    if (job.status === 'processing' && job.attempts >= job.max_attempts) {
      try {
        const errorSummary = `Job processing lease expired after ${job.attempts} attempts; marking terminal failure.`;
        await updateJobStatus(job.id, {
          status: 'failed',
          stage: 'failed',
          errorSummary,
        });

        await query(
          `UPDATE document_versions
           SET status = 'failed',
               error_message = $1,
               updated_at = now()
           WHERE id = $2 AND status != 'ready'`,
          [errorSummary, versionId]
        );

        exhausted++;
      } catch {
        errors++;
      }
      continue;
    }

    // If job was stranded in processing but has remaining attempts, reset it to queued
    if (job.status === 'processing') {
      try {
        await query(
          `UPDATE jobs
           SET status = 'queued',
               locked_by = NULL,
               locked_until = NULL,
               updated_at = now()
           WHERE id = $1 AND status = 'processing'`,
          [job.id]
        );
      } catch {
        errors++;
        continue;
      }
    }

    const jobData: IngestionJobData = {
      jobId: job.id,
      organizationId: job.organization_id,
      documentId,
      versionId,
      type: job.type as 'document_ingestion' | 'document_reindex' | 'repo_import',
      config: payload.config as IngestionJobData['config'],
    };

    try {
      if (options?.processDirectly) {
        await processIngestionJobDirectly(
          jobData,
          options?.provider ? { overrideProvider: options.provider } : undefined
        );
        recovered++;
      } else {
        const enqueued = await enqueueIngestionJob(jobData);
        if (enqueued) {
          recovered++;
        }
      }
    } catch {
      errors++;
    }
  }

  return {
    scanned: stuckJobs.length,
    recovered,
    exhausted,
    errors,
  };
}

/**
 * Starts a recurring background recovery scan in the worker process.
 * Prevents overlapping scans within the process and handles unexpected errors cleanly.
 */
export function startPeriodicRecovery(options?: {
  intervalMs?: number;
  olderThanSeconds?: number;
  staleProcessingSeconds?: number;
  limit?: number;
}): void {
  if (periodicRecoveryTimer) {
    return;
  }

  const intervalMs = options?.intervalMs ?? 30000;

  periodicRecoveryTimer = setInterval(async () => {
    if (isPeriodicScanning) {
      // Prevent overlapping runs within the same process
      return;
    }

    isPeriodicScanning = true;
    try {
      const res = await recoverStuckQueuedJobs({
        olderThanSeconds: options?.olderThanSeconds ?? 30,
        staleProcessingSeconds: options?.staleProcessingSeconds ?? 60,
        limit: options?.limit ?? 50,
      });

      if (res.recovered > 0 || res.exhausted > 0) {
        console.log(
          `[Periodic Recovery]: Processed ${res.scanned} stuck jobs (recovered: ${res.recovered}, exhausted: ${res.exhausted}).`
        );
      }
    } catch (err) {
      console.warn(`[Periodic Recovery Warning]: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isPeriodicScanning = false;
    }
  }, intervalMs);

  periodicRecoveryTimer.unref?.();
}

/**
 * Gracefully stops the periodic recovery scanner and waits for in-flight scans to finish.
 */
export async function stopPeriodicRecovery(): Promise<void> {
  if (periodicRecoveryTimer) {
    clearInterval(periodicRecoveryTimer);
    periodicRecoveryTimer = null;
  }

  let waitCount = 0;
  while (isPeriodicScanning && waitCount < 20) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    waitCount++;
  }
}
