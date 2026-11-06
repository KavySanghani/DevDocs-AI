import { validateEnv } from './config/env.js';
import { closePool } from '@devdocs/db';
import {
  closeRedisConnections,
  isRedisAvailable,
} from './services/queue/connection.js';
import {
  startIngestionWorker,
  closeIngestionWorker,
} from './services/queue/ingestionWorker.js';
import {
  recoverStuckQueuedJobs,
  startPeriodicRecovery,
  stopPeriodicRecovery,
} from './services/queue/recovery.js';

async function main() {
  const env = validateEnv();
  console.log('='.repeat(60));
  console.log('DevDocs AI — Background Ingestion Worker');
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log(`Worker Concurrency: ${env.WORKER_CONCURRENCY}`);
  console.log(`Max Ingestion Attempts: ${env.INGESTION_MAX_ATTEMPTS}`);
  console.log('='.repeat(60));

  // Check Redis connectivity
  const redisOk = await isRedisAvailable();
  if (!redisOk) {
    console.warn(
      `[Worker Startup Warning]: Redis at ${env.REDIS_URL} is currently unreachable. Worker will listen when connection restores.`
    );
  } else {
    console.log(`Connected to Redis at ${env.REDIS_URL}`);
  }

  // 1. Startup Recovery: scan PostgreSQL for any stuck queued or stale processing work and re-enqueue it
  try {
    const recoveryResult = await recoverStuckQueuedJobs({
      olderThanSeconds: 10,
      staleProcessingSeconds: 30,
    });
    if (recoveryResult.recovered > 0 || recoveryResult.exhausted > 0) {
      console.log(
        `[Worker Startup]: Processed ${recoveryResult.scanned} stuck jobs (recovered: ${recoveryResult.recovered}, exhausted: ${recoveryResult.exhausted}).`
      );
    }
  } catch (err) {
    console.warn(`[Worker Startup Recovery Warning]: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Start BullMQ Worker
  startIngestionWorker({ concurrency: env.WORKER_CONCURRENCY });
  console.log(`BullMQ Ingestion Worker started (listening on queue 'document-ingestion').`);

  // 3. Start Recurring Recovery Scanner (default every 30 seconds)
  startPeriodicRecovery({
    intervalMs: 30000,
    olderThanSeconds: 30,
    staleProcessingSeconds: 60,
  });
  console.log(`Periodic Recovery Scanner scheduled (running every 30s).`);

  // 4. Handle Graceful Shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down worker gracefully...`);
    try {
      await stopPeriodicRecovery();
      console.log('Periodic recovery scanner stopped.');
      await closeIngestionWorker();
      console.log('Ingestion worker stopped.');
      await closeRedisConnections();
      console.log('Redis connections closed.');
      await closePool();
      console.log('Database pool closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal worker startup error:', err);
  process.exit(1);
});
