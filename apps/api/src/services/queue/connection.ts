import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from '../../config/env.js';

let sharedRedisClient: Redis | null = null;
let isShuttingDown = false;

/**
 * Creates or retrieves a shared ioredis connection configured for BullMQ.
 * BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`.
 */
export function getRedisConnection(overrideOptions?: Partial<RedisOptions>): Redis {
  if (sharedRedisClient && !isShuttingDown) {
    return sharedRedisClient;
  }

  const env = getEnv();
  const redisUrl = env.REDIS_URL || 'redis://127.0.0.1:6379';

  const defaultOptions: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times) {
      if (isShuttingDown) return null;
      // Exponential backoff capped at 2 seconds
      return Math.min(times * 100, 2000);
    },
    ...overrideOptions,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedRedisClient = new Redis(redisUrl, defaultOptions as any);

  // Prevent uncaught errors from crashing the process when Redis is disconnected
  sharedRedisClient.on('error', (err: unknown) => {
    // Only log if not in silent test mode
    if (env.NODE_ENV !== 'test' && !isShuttingDown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Redis Connection Warning]: ${msg}`);
    }
  });

  return sharedRedisClient;
}

/**
 * Checks if Redis is currently reachable with a fast PING timeout.
 */
export async function isRedisAvailable(client?: Redis, timeoutMs = 800): Promise<boolean> {
  const redis = client ?? getRedisConnection();
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    const pingPromise = redis.ping();
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('Redis ping timed out')), timeoutMs)
    );
    const result = await Promise.race([pingPromise, timeoutPromise]);
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Gracefully disconnects all Redis connections on application shutdown.
 */
export async function closeRedisConnections(): Promise<void> {
  isShuttingDown = true;
  if (sharedRedisClient) {
    try {
      if (sharedRedisClient.status !== 'end') {
        await sharedRedisClient.quit();
      }
    } catch {
      sharedRedisClient.disconnect();
    } finally {
      sharedRedisClient = null;
      isShuttingDown = false;
    }
  }
}
