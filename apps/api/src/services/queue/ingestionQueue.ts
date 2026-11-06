import { Queue, type JobsOptions } from 'bullmq';
import { getRedisConnection } from './connection.js';
import { getEnv } from '../../config/env.js';

export interface IngestionJobData {
  jobId: string;
  organizationId: string;
  documentId: string;
  versionId: string;
  type: 'document_ingestion' | 'document_reindex';
  config?: {
    maxChunkSizeChars?: number | undefined;
    chunkOverlapChars?: number | undefined;
    minChunkSizeChars?: number | undefined;
  } | undefined;
}

export const INGESTION_QUEUE_NAME = 'document-ingestion';

let ingestionQueue: Queue<IngestionJobData> | null = null;

/**
 * Initializes or retrieves the singleton BullMQ Queue instance.
 */
export function getIngestionQueue(): Queue<IngestionJobData> {
  if (ingestionQueue) {
    return ingestionQueue;
  }

  const env = getEnv();
  const redis = getRedisConnection();

  const defaultJobOptions: JobsOptions = {
    attempts: env.INGESTION_MAX_ATTEMPTS ?? 3,
    backoff: {
      type: 'exponential',
      delay: env.INGESTION_BACKOFF_MS ?? 1000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  };

  ingestionQueue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions,
  });

  return ingestionQueue;
}

/**
 * Enqueues an ingestion job with a deterministic job ID.
 * Returns true if enqueued to Redis, false if Redis was unavailable (left in DB outbox).
 */
export async function enqueueIngestionJob(data: IngestionJobData): Promise<boolean> {
  try {
    const queue = getIngestionQueue();
    // Use the durable PostgreSQL jobId as the BullMQ jobId to enforce deterministic queue de-duplication
    await queue.add('ingest', data, {
      jobId: data.jobId,
    });
    return true;
  } catch (err) {
    // If Redis is unreachable, the job is already safely committed to PostgreSQL.
    // The outbox scanner will recover and re-enqueue it once Redis is available.
    if (getEnv().NODE_ENV !== 'test') {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Queue Enqueue Warning]: Failed to enqueue job ${data.jobId} to Redis: ${msg}`);
    }
    return false;
  }
}

/**
 * Closes the BullMQ queue cleanly on application shutdown.
 */
export async function closeIngestionQueue(): Promise<void> {
  if (ingestionQueue) {
    try {
      await ingestionQueue.close();
    } finally {
      ingestionQueue = null;
    }
  }
}
