import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export * from './safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate and load root .env reliably across monorepo and workspace execution
const rootEnvPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(rootEnvPath)) {
  config({ path: rootEnvPath });
}
// Fallback to process.cwd() .env if present (preserves existing process.env variables)
config();

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is not defined. Please set DATABASE_URL in your .env file or environment.'
    );
  }
  return url;
}

export function getPool(connectionString?: string): pg.Pool {
  if (!pool || (connectionString && pool.options.connectionString !== connectionString)) {
    const url = connectionString ?? getDatabaseUrl();
    pool = new Pool({
      connectionString: url,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      // Prevent unhandled errors from terminating process
      console.error('[DATABASE POOL ERROR]', err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<R>> {
  const p = getPool();
  return p.query<R>(text, params);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  connectionString?: string
): Promise<T> {
  const p = getPool(connectionString);
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabaseHealth(
  connectionString?: string
): Promise<{ status: 'ok' | 'error'; latencyMs: number; error?: string }> {
  const start = performance.now();
  try {
    const p = getPool(connectionString);
    await p.query('SELECT 1');
    return {
      status: 'ok',
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
