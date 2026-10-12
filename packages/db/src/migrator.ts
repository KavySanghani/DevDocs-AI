import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { getDatabaseUrl, getPool } from './index.js';
import { validateDevResetSafety, validateTestResetSafety } from './safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Migration {
  version: string;
  name: string;
  filename: string;
  sql: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  filename: string;
  applied: boolean;
  appliedAt?: Date | undefined;
}

/**
 * Resolves the default migrations directory (db/migrations at workspace root).
 */
export function getDefaultMigrationsDir(): string {
  // From packages/db/src/ or packages/db/dist/, navigate to <workspace_root>/db/migrations
  return path.resolve(__dirname, '../../../db/migrations');
}

/**
 * Loads all .sql migration files from the migrations directory, sorted by filename.
 */
export async function loadMigrations(migrationsDir?: string): Promise<Migration[]> {
  const dir = migrationsDir ?? getDefaultMigrationsDir();
  const files = await fs.readdir(dir);
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

  const migrations: Migration[] = [];
  for (const file of sqlFiles) {
    const fullPath = path.join(dir, file);
    const sql = await fs.readFile(fullPath, 'utf8');
    const version = file.split('_')[0] ?? file.replace('.sql', '');
    const name = file.replace(/^\d+_/, '').replace('.sql', '');

    migrations.push({
      version,
      name,
      filename: file,
      sql,
    });
  }

  return migrations;
}

/**
 * Ensures the migration tracking table exists.
 */
export async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Retrieves list of already-applied migration versions.
 */
export async function getAppliedMigrationRecords(
  client: PoolClient
): Promise<Map<string, Date>> {
  await ensureMigrationsTable(client);
  const res = await client.query<{ version: string; applied_at: Date }>(
    'SELECT version, applied_at FROM schema_migrations ORDER BY applied_at ASC'
  );
  const map = new Map<string, Date>();
  for (const row of res.rows) {
    map.set(row.version, row.applied_at);
  }
  return map;
}

/**
 * Executes all pending migrations sequentially inside transactions.
 */
export async function runMigrations(
  connectionString?: string,
  migrationsDir?: string
): Promise<{ applied: string[]; skipped: string[] }> {
  const migrations = await loadMigrations(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const pool = getPool(connectionString);
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const appliedMap = await getAppliedMigrationRecords(client);

    for (const m of migrations) {
      if (appliedMap.has(m.version)) {
        skipped.push(m.filename);
        continue;
      }

      console.log(`[MIGRATION] Applying ${m.filename}...`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, now())',
          [m.version, m.name]
        );
        await client.query('COMMIT');
        applied.push(m.filename);
        console.log(`[MIGRATION] Successfully applied ${m.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[MIGRATION ERROR] Failed on ${m.filename}:`, err);
        throw err;
      }
    }
  } finally {
    client.release();
  }

  return { applied, skipped };
}

/**
 * Returns migration status for all available migrations.
 */
export async function getMigrationStatus(
  connectionString?: string,
  migrationsDir?: string
): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(migrationsDir);
  const pool = getPool(connectionString);
  const client = await pool.connect();

  try {
    const appliedMap = await getAppliedMigrationRecords(client);

    return migrations.map((m) => {
      const appliedAt = appliedMap.get(m.version);
      return {
        version: m.version,
        name: m.name,
        filename: m.filename,
        applied: appliedAt !== undefined,
        appliedAt,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Internal helper to drop and recreate the public schema.
 */
async function dropAndRecreatePublicSchema(connectionString: string): Promise<void> {
  const pool = getPool(connectionString);
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await client.query('CREATE SCHEMA public;');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC;');
  } finally {
    client.release();
  }
}

/**
 * Resets the database schema for local development.
 *
 * CRITICAL SAFETY REQUIREMENTS:
 * - NODE_ENV must be explicitly 'development' (rejects unset, empty, production, test, etc.).
 * - ALLOW_DB_RESET must be explicitly set to 'true'.
 * - Target host must be a recognized local loopback address (localhost, 127.0.0.1, ::1).
 * - Target database must be a verified safe local development database.
 *
 * WARNING: This operation DROPS the entire 'public' schema and ALL objects,
 * tables, views, triggers, functions, and data records in the target database.
 */
export async function resetDatabase(
  connectionString?: string,
  migrationsDir?: string
): Promise<{ reapplied: string[]; target: string }> {
  const rawUrl = connectionString ?? getDatabaseUrl();
  const target = validateDevResetSafety(rawUrl);

  console.warn(
    `[RESET] WARNING: Dropping schema 'public' and ALL tables/data in ${target.sanitized}...`
  );
  await dropAndRecreatePublicSchema(rawUrl);

  console.log(`[RESET] Re-running all migrations from scratch on ${target.sanitized}...`);
  const result = await runMigrations(rawUrl, migrationsDir);
  return { reapplied: result.applied, target: target.sanitized };
}

/**
 * Resets the dedicated test database schema for automated tests.
 *
 * CRITICAL SAFETY REQUIREMENTS:
 * - NODE_ENV must be 'test' or running inside a test runner (VITEST=true).
 * - Dedicated test database name must end in '_test'.
 * - Target database must NOT match the application DATABASE_URL.
 * - Production targets are strictly prohibited.
 *
 * WARNING: This operation DROPS the entire 'public' schema in the test database.
 */
export async function resetTestDatabase(
  testConnectionString: string,
  appConnectionString?: string,
  migrationsDir?: string
): Promise<{ reapplied: string[]; target: string }> {
  const target = validateTestResetSafety(
    testConnectionString,
    appConnectionString ?? process.env.DATABASE_URL
  );

  console.log(
    `[TEST RESET] Resetting dedicated test database schema on ${target.sanitized}...`
  );
  await dropAndRecreatePublicSchema(testConnectionString);

  console.log(`[TEST RESET] Re-running migrations on ${target.sanitized}...`);
  const result = await runMigrations(testConnectionString, migrationsDir);
  return { reapplied: result.applied, target: target.sanitized };
}
