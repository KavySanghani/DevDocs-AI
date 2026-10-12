import { closePool, getDatabaseUrl, parseDatabaseUrl } from './index.js';
import { getMigrationStatus, resetDatabase, runMigrations } from './migrator.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';

  try {
    const url = getDatabaseUrl();
    const sanitizedUrl = parseDatabaseUrl(url).sanitized;
    console.log(`[DB CLI] Target Database: ${sanitizedUrl}`);

    switch (command) {
      case 'migrate': {
        console.log('[DB CLI] Running pending migrations...');
        const result = await runMigrations();
        if (result.applied.length === 0) {
          console.log('[DB CLI] Database is already up to date. No pending migrations.');
        } else {
          console.log(`[DB CLI] Applied ${result.applied.length} migration(s):`);
          for (const m of result.applied) {
            console.log(`  ✓ ${m}`);
          }
        }
        break;
      }

      case 'status': {
        console.log('[DB CLI] Checking migration status...');
        const statuses = await getMigrationStatus();
        console.log('\nMigration History:');
        console.log('------------------------------------------------------------');
        for (const s of statuses) {
          const statusIcon = s.applied ? '✓ APPLIED' : '○ PENDING';
          const appliedDate = s.appliedAt ? ` (at ${s.appliedAt.toISOString()})` : '';
          console.log(`[${statusIcon}] ${s.filename}${appliedDate}`);
        }
        console.log('------------------------------------------------------------\n');
        break;
      }

      case 'reset': {
        console.warn('============================================================');
        console.warn('  WARNING: DATABASE RESET REQUESTED');
        console.warn('  This operation DROPS the public schema and deletes ALL data,');
        console.warn('  tables, views, functions, and types in the target database.');
        console.warn('  Strictly permitted only for local development environments.');
        console.warn('  Requires: NODE_ENV=development, ALLOW_DB_RESET=true, and loopback host.');
        console.warn('============================================================');

        const result = await resetDatabase();
        console.log(`[DB CLI] Reset complete on ${result.target}. Reapplied ${result.reapplied.length} migration(s).`);
        break;
      }

      default: {
        console.error(`Unknown command: ${command}`);
        console.log('Available commands: migrate, status, reset');
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('[DB CLI ERROR]', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

void main();
