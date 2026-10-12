export interface ParsedDbTarget {
  protocol: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sanitized: string;
}

/**
 * Parses a PostgreSQL connection URL into its individual components.
 * Produces a sanitized connection string that NEVER exposes passwords.
 */
export function parseDatabaseUrl(rawUrl: string): ParsedDbTarget {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Database URL must be a non-empty string.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid database connection string: could not parse as URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Unsupported database protocol: "${parsed.protocol}". Expected "postgresql:" or "postgres:".`
    );
  }

  const rawHost = (parsed.hostname || '').toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, '');
  if (!host) {
    throw new Error('Database connection URL is missing a hostname.');
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port in database connection URL: "${parsed.port}".`);
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0]?.trim();
  if (!dbName) {
    throw new Error('Database connection URL is missing a database name in the path.');
  }

  const user = parsed.username || 'postgres';
  const userInfo = user ? `${user}@` : '';
  const hostDisplay = host.includes(':') ? `[${host}]` : host;
  const sanitized = `${parsed.protocol}//${userInfo}${hostDisplay}:${port}/${dbName}`;

  return {
    protocol: parsed.protocol,
    host,
    port,
    database: dbName,
    user,
    sanitized,
  };
}

/**
 * Checks if a hostname resolves to a local loopback interface (localhost, 127.0.0.1, or ::1).
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

/**
 * Checks if a host appears to be a remote or cloud-hosted database.
 */
export function isProductionHost(host: string): boolean {
  const h = host.toLowerCase();
  const prodIndicators = [
    'rds.amazonaws.com',
    'supabase.co',
    'neon.tech',
    'render.com',
    'elephantsql.com',
    'railway.app',
    'fly.dev',
    'azure.com',
    'cloudsql',
    'aivencloud.com',
  ];
  return prodIndicators.some((indicator) => h.includes(indicator));
}

/**
 * Compares two parsed database targets to determine if they target the same database.
 * Treats loopback aliases (localhost vs 127.0.0.1) as equivalent hosts.
 */
export function areTargetsEquivalent(a: ParsedDbTarget, b: ParsedDbTarget): boolean {
  const sameHost =
    a.host === b.host || (isLoopbackHost(a.host) && isLoopbackHost(b.host));
  const samePort = a.port === b.port;
  const sameDb = a.database.toLowerCase() === b.database.toLowerCase();
  return sameHost && samePort && sameDb;
}

/**
 * Validates that a connection target is a dedicated test database.
 * Requires the database name to end in '_test' and strictly rejects targets
 * that match the configured application DATABASE_URL.
 */
export function validateTestDatabaseTarget(
  testUrl: string,
  appUrl?: string
): ParsedDbTarget {
  const target = parseDatabaseUrl(testUrl);

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Safety violation: test database operations are strictly prohibited in production.'
    );
  }

  if (isProductionHost(target.host)) {
    throw new Error(
      `Safety violation: test database target "${target.sanitized}" appears to be a remote production database.`
    );
  }

  if (!target.database.endsWith('_test')) {
    throw new Error(
      `Safety violation: test database name "${target.database}" does not end in "_test". ` +
        `Dedicated test databases must end with "_test" to protect non-test environments. Target: ${target.sanitized}`
    );
  }

  if (appUrl) {
    try {
      const appTarget = parseDatabaseUrl(appUrl);
      if (areTargetsEquivalent(target, appTarget)) {
        throw new Error(
          `Safety violation: test database target matches the configured application DATABASE_URL. ` +
            `Refusing to use application database for tests. Test target: ${target.sanitized}, App target: ${appTarget.sanitized}`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Safety violation:')) {
        throw err;
      }
      // If appUrl is invalid or unparseable, continue
    }
  }

  return target;
}

/**
 * Validates whether a manual database reset is permitted for local development.
 * Requires:
 * 1. NODE_ENV must be explicitly 'development' (rejects unset, empty, production, test, etc.).
 * 2. ALLOW_DB_RESET must be explicitly 'true'.
 * 3. Database host must be a recognized local loopback address ('localhost', '127.0.0.1', or '::1').
 * 4. Database target must not be production/staging.
 */
export function validateDevResetSafety(rawUrl: string): ParsedDbTarget {
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv || nodeEnv.trim() === '') {
    throw new Error(
      "Database reset rejected: NODE_ENV is unset. Reset requires NODE_ENV='development'."
    );
  }

  if (nodeEnv !== 'development') {
    throw new Error(
      `Database reset rejected: NODE_ENV must be explicitly 'development' (current: '${nodeEnv}'). ` +
        'Reset is strictly prohibited in other environments.'
    );
  }

  if (process.env.ALLOW_DB_RESET !== 'true') {
    throw new Error(
      "Database reset rejected: manual development reset requires ALLOW_DB_RESET='true'. " +
        'Example: ALLOW_DB_RESET=true npm run db:reset'
    );
  }

  const target = parseDatabaseUrl(rawUrl);

  if (!isLoopbackHost(target.host)) {
    throw new Error(
      `Database reset rejected: target host "${target.host}" is not a recognized local loopback address (localhost, 127.0.0.1, or ::1). ` +
        'Manual development reset is strictly prohibited against remote or non-loopback database hosts.'
    );
  }

  const dbLower = target.database.toLowerCase();
  if (
    dbLower.includes('prod') ||
    dbLower.includes('production') ||
    dbLower.includes('staging') ||
    isProductionHost(target.host)
  ) {
    throw new Error(
      `Database reset rejected: target "${target.sanitized}" appears to be a production or staging database.`
    );
  }

  return target;
}

/**
 * Validates whether an automated test reset is permitted on the target test database.
 * Requires:
 * 1. NODE_ENV must be 'test' or running inside a test runner (VITEST=true).
 * 2. Cannot be production.
 * 3. Test database name must end in '_test'.
 * 4. Target must not match application DATABASE_URL.
 */
export function validateTestResetSafety(
  testUrl: string,
  appUrl?: string
): ParsedDbTarget {
  const nodeEnv = process.env.NODE_ENV;
  const isVitest = process.env.VITEST === 'true';

  if (nodeEnv === 'production') {
    throw new Error('Database reset rejected: strictly prohibited in production.');
  }

  if (nodeEnv !== 'test' && !isVitest) {
    throw new Error(
      `Test database reset rejected: NODE_ENV must be 'test' or running inside Vitest (current: '${nodeEnv ?? '<unset>'}').`
    );
  }

  return validateTestDatabaseTarget(testUrl, appUrl);
}
