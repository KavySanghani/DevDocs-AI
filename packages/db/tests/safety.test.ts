import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseDatabaseUrl,
  areTargetsEquivalent,
  isLoopbackHost,
  isProductionHost,
  validateTestDatabaseTarget,
  validateDevResetSafety,
  validateTestResetSafety,
} from '../src/safety.js';
import { resetDatabase } from '../src/migrator.js';

describe('Database Reset Safeguards & Target Isolation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('1. URL Parsing & Credential Redaction', () => {
    it('parses host, port, database, and user correctly', () => {
      const target = parseDatabaseUrl(
        'postgresql://devdocs:super_secret_pw@localhost:5432/devdocs_ai'
      );
      expect(target.protocol).toBe('postgresql:');
      expect(target.host).toBe('localhost');
      expect(target.port).toBe(5432);
      expect(target.database).toBe('devdocs_ai');
      expect(target.user).toBe('devdocs');
    });

    it('NEVER includes passwords in sanitized connection string', () => {
      const secret = 'ultra_secret_password_123!';
      const target = parseDatabaseUrl(
        `postgresql://db_user:${secret}@localhost:5433/devdocs_ai`
      );
      expect(target.sanitized).not.toContain(secret);
      expect(target.sanitized).toBe('postgresql://db_user@localhost:5433/devdocs_ai');
    });

    it('defaults to port 5432 when port is omitted in URL', () => {
      const target = parseDatabaseUrl('postgresql://localhost/devdocs_ai');
      expect(target.port).toBe(5432);
      expect(target.database).toBe('devdocs_ai');
    });

    it('rejects unsupported protocols (e.g. http, mysql)', () => {
      expect(() => parseDatabaseUrl('mysql://localhost:3306/devdocs')).toThrow(
        /Unsupported database protocol/
      );
      expect(() => parseDatabaseUrl('https://example.com/api')).toThrow(
        /Unsupported database protocol/
      );
    });

    it('rejects empty database names', () => {
      expect(() => parseDatabaseUrl('postgresql://localhost:5432/')).toThrow(
        /missing a database name/
      );
    });
  });

  describe('2. Loopback & Host Equivalency Checking', () => {
    it('identifies loopback hosts correctly (localhost, 127.0.0.1, ::1)', () => {
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('0.0.0.0')).toBe(false);
      expect(isLoopbackHost('db.example.com')).toBe(false);
      expect(isLoopbackHost('192.168.1.10')).toBe(false);
      expect(isLoopbackHost('custom-db.internal')).toBe(false);
    });

    it('identifies known production cloud hosts', () => {
      expect(isProductionHost('devdocs-db.c123.rds.amazonaws.com')).toBe(true);
      expect(isProductionHost('db.project.supabase.co')).toBe(true);
      expect(isProductionHost('ep-cool-fog-123.us-east-2.aws.neon.tech')).toBe(true);
      expect(isProductionHost('localhost')).toBe(false);
      expect(isProductionHost('127.0.0.1')).toBe(false);
    });

    it('treats localhost and 127.0.0.1 on the same port and database as equivalent', () => {
      const a = parseDatabaseUrl('postgresql://localhost:5432/devdocs_ai');
      const b = parseDatabaseUrl('postgresql://127.0.0.1:5432/devdocs_ai');
      expect(areTargetsEquivalent(a, b)).toBe(true);
    });

    it('differentiates distinct database names on same host', () => {
      const dev = parseDatabaseUrl('postgresql://localhost:5432/devdocs_ai');
      const test = parseDatabaseUrl('postgresql://localhost:5432/devdocs_ai_test');
      expect(areTargetsEquivalent(dev, test)).toBe(false);
    });

    it('differentiates distinct ports on same host', () => {
      const port5432 = parseDatabaseUrl('postgresql://localhost:5432/devdocs_ai');
      const port5433 = parseDatabaseUrl('postgresql://localhost:5433/devdocs_ai');
      expect(areTargetsEquivalent(port5432, port5433)).toBe(false);
    });
  });

  describe('3. Test Database Target Validation & Isolation', () => {
    it('accepts a valid dedicated test database ending in _test', () => {
      const target = validateTestDatabaseTarget(
        'postgresql://localhost:5433/devdocs_ai_test',
        'postgresql://localhost:5433/devdocs_ai'
      );
      expect(target.database).toBe('devdocs_ai_test');
    });

    it('rejects test database whose name does not end in _test', () => {
      expect(() =>
        validateTestDatabaseTarget('postgresql://localhost:5433/devdocs_ai')
      ).toThrow(/must end with "_test"/);

      expect(() =>
        validateTestDatabaseTarget('postgresql://localhost:5433/production')
      ).toThrow(/must end with "_test"/);
    });

    it('rejects test database target if it matches application DATABASE_URL', () => {
      const appUrl = 'postgresql://localhost:5433/devdocs_ai_test';
      const testUrl = 'postgresql://127.0.0.1:5433/devdocs_ai_test';

      expect(() => validateTestDatabaseTarget(testUrl, appUrl)).toThrow(
        /test database target matches the configured application DATABASE_URL/
      );
    });

    it('rejects test database operations in production environment', () => {
      process.env.NODE_ENV = 'production';
      expect(() =>
        validateTestDatabaseTarget('postgresql://localhost:5433/devdocs_ai_test')
      ).toThrow(/test database operations are strictly prohibited in production/);
    });

    it('rejects test database targets pointing to remote production hosts', () => {
      expect(() =>
        validateTestDatabaseTarget(
          'postgresql://user:pass@prod.rds.amazonaws.com:5432/app_test'
        )
      ).toThrow(/appears to be a remote production database/);
    });
  });

  describe('4. Development Reset Safety Guards', () => {
    it('rejects reset when NODE_ENV is unset', () => {
      delete process.env.NODE_ENV;
      process.env.ALLOW_DB_RESET = 'true';
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/devdocs_ai')
      ).toThrow(/NODE_ENV is unset/);
    });

    it('rejects reset when NODE_ENV is empty string', () => {
      process.env.NODE_ENV = '   ';
      process.env.ALLOW_DB_RESET = 'true';
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/devdocs_ai')
      ).toThrow(/NODE_ENV is unset/);
    });

    it('rejects reset when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_DB_RESET = 'true';
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/devdocs_ai')
      ).toThrow(/NODE_ENV must be explicitly 'development'/);
    });

    it('rejects reset when NODE_ENV is staging or preview', () => {
      process.env.NODE_ENV = 'staging';
      process.env.ALLOW_DB_RESET = 'true';
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/devdocs_ai')
      ).toThrow(/NODE_ENV must be explicitly 'development'/);
    });

    it('rejects reset when ALLOW_DB_RESET is missing or not true', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.ALLOW_DB_RESET;
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/devdocs_ai')
      ).toThrow(/manual development reset requires ALLOW_DB_RESET='true'/);

      process.env.ALLOW_DB_RESET = 'false';
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/devdocs_ai')
      ).toThrow(/manual development reset requires ALLOW_DB_RESET='true'/);
    });

    it('rejects reset when target database name contains prod or production', () => {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_DB_RESET = 'true';
      expect(() =>
        validateDevResetSafety('postgresql://localhost:5432/my_production_db')
      ).toThrow(/appears to be a production or staging database/);
    });

    it('rejects reset when target host is a remote or non-loopback host even if database name is safe', () => {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_DB_RESET = 'true';

      // Remote hostname that does NOT contain 'prod' or cloud provider names
      expect(() =>
        validateDevResetSafety('postgresql://database.internal:5432/my_dev_db')
      ).toThrow(/not a recognized local loopback address \(localhost, 127\.0\.0\.1, or ::1\)/);

      expect(() =>
        validateDevResetSafety('postgresql://192.168.1.100:5432/my_dev_db')
      ).toThrow(/not a recognized local loopback address \(localhost, 127\.0\.0\.1, or ::1\)/);

      expect(() =>
        validateDevResetSafety('postgresql://remote-worker.company.net:5432/my_dev_db')
      ).toThrow(/not a recognized local loopback address \(localhost, 127\.0\.0\.1, or ::1\)/);
    });

    it('accepts development reset on all recognized loopback addresses (localhost, 127.0.0.1, ::1)', () => {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_DB_RESET = 'true';

      const target1 = validateDevResetSafety('postgresql://localhost:5433/devdocs_ai');
      expect(target1.host).toBe('localhost');

      const target2 = validateDevResetSafety('postgresql://127.0.0.1:5433/devdocs_ai');
      expect(target2.host).toBe('127.0.0.1');

      const target3 = validateDevResetSafety('postgresql://[::1]:5433/devdocs_ai');
      expect(target3.host).toBe('::1');
    });
  });

  describe('5. resetDatabase API Refusal Without Destructive Action', () => {
    it('resetDatabase throws immediately if NODE_ENV is unset or incorrect without touching db', async () => {
      delete process.env.NODE_ENV;
      process.env.ALLOW_DB_RESET = 'true';

      await expect(
        resetDatabase('postgresql://localhost:5433/devdocs_ai')
      ).rejects.toThrow(/NODE_ENV is unset/);
    });

    it('resetDatabase throws immediately if ALLOW_DB_RESET is not true', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.ALLOW_DB_RESET;

      await expect(
        resetDatabase('postgresql://localhost:5433/devdocs_ai')
      ).rejects.toThrow(/ALLOW_DB_RESET='true'/);
    });

    it('resetDatabase throws immediately if target host is remote without touching db', async () => {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_DB_RESET = 'true';

      await expect(
        resetDatabase('postgresql://remote-db.example.com:5432/devdocs_ai')
      ).rejects.toThrow(/not a recognized local loopback address/);
    });
  });

  describe('6. Test Reset Guard (validateTestResetSafety)', () => {
    it('rejects test reset when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      expect(() =>
        validateTestResetSafety('postgresql://localhost:5433/devdocs_ai_test')
      ).toThrow(/strictly prohibited in production/);
    });

    it('rejects test reset when test target is not ending in _test', () => {
      process.env.NODE_ENV = 'test';
      expect(() =>
        validateTestResetSafety('postgresql://localhost:5433/devdocs_ai')
      ).toThrow(/must end with "_test"/);
    });
  });
});
