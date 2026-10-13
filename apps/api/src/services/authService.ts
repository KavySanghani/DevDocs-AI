import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '@devdocs/db';
import type { JwtTokenPayload, UserResponse } from '@devdocs/shared';

export interface TokenResult {
  token: string;
  jti: string;
  expiresInSeconds: number;
}

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  account_status: 'active' | 'suspended' | 'deactivated';
  created_at: Date;
  updated_at: Date;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Hashes a plaintext password using bcrypt with 10 salt rounds.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compares a candidate plaintext password against a stored bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generates an expiring JWT token with a unique JWT ID (jti).
 */
export function generateToken(
  payload: { userId: string; email: string },
  secret: string,
  expiresIn: string = '24h'
): TokenResult {
  const jti = crypto.randomUUID();
  const tokenPayload: JwtTokenPayload = {
    userId: payload.userId,
    email: payload.email,
    jti,
  };

  const expiry = expiresIn || '24h';
  const token = jwt.sign(tokenPayload, secret, {
    expiresIn: expiry as '24h',
  });

  // Calculate approximate lifetime in seconds (default 24h = 86400s)
  const expiresInSeconds = 86400;

  return { token, jti, expiresInSeconds };
}

/**
 * Verifies and decodes a JWT token.
 * Throws an AuthError if the token is expired or invalid.
 */
export function verifyToken(token: string, secret: string): JwtTokenPayload {
  try {
    const decoded = jwt.verify(token, secret) as JwtTokenPayload;
    if (!decoded.userId || !decoded.email || !decoded.jti) {
      throw new AuthError('Invalid token payload', 401, 'INVALID_TOKEN');
    }
    return decoded;
  } catch (err) {
    if (
      err instanceof jwt.TokenExpiredError ||
      (err instanceof Error && err.name === 'TokenExpiredError')
    ) {
      throw new AuthError('Token has expired', 401, 'TOKEN_EXPIRED');
    }
    if (err instanceof jwt.JsonWebTokenError || (err instanceof Error && err.name === 'JsonWebTokenError')) {
      throw new AuthError('Invalid token signature or format', 401, 'INVALID_TOKEN');
    }
    if (err instanceof AuthError) {
      throw err;
    }
    throw new AuthError('Authentication failed', 401, 'UNAUTHORIZED');
  }
}

/**
 * Registers a new user account.
 * Throws 409 CONFLICT if the email already exists.
 */
export async function registerUser(
  email: string,
  password: string,
  jwtSecret: string
): Promise<{ user: UserResponse; token: string; expiresIn: number }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check if email already exists
  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [normalizedEmail]
  );
  if (existing.rows.length > 0) {
    throw new AuthError('An account with this email address already exists', 409, 'EMAIL_ALREADY_EXISTS');
  }

  const passwordHash = await hashPassword(password);

  const res = await query<UserRecord>(
    `INSERT INTO users (email, password_hash, account_status)
     VALUES ($1, $2, 'active')
     RETURNING id, email, account_status, created_at, updated_at`,
    [normalizedEmail, passwordHash]
  );

  const userRow = res.rows[0];
  if (!userRow) {
    throw new AuthError('Failed to create user', 500, 'INTERNAL_SERVER_ERROR');
  }

  const user: UserResponse = {
    id: userRow.id,
    email: userRow.email,
    accountStatus: userRow.account_status,
    createdAt: userRow.created_at.toISOString(),
  };

  const { token, expiresInSeconds } = generateToken(
    { userId: user.id, email: user.email },
    jwtSecret
  );

  return { user, token, expiresIn: expiresInSeconds };
}

/**
 * Authenticates an existing user by email and password.
 * Returns consistent 401 INVALID_CREDENTIALS error to prevent user enumeration.
 */
export async function loginUser(
  email: string,
  password: string,
  jwtSecret: string
): Promise<{ user: UserResponse; token: string; expiresIn: number }> {
  const normalizedEmail = email.toLowerCase().trim();

  const res = await query<UserRecord>(
    `SELECT id, email, password_hash, account_status, created_at, updated_at
     FROM users WHERE email = $1`,
    [normalizedEmail]
  );

  const userRow = res.rows[0];
  if (!userRow) {
    throw new AuthError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }

  if (userRow.account_status !== 'active') {
    throw new AuthError(
      `Account is ${userRow.account_status}. Please contact support.`,
      403,
      'ACCOUNT_INACTIVE'
    );
  }

  const passwordMatches = await comparePassword(password, userRow.password_hash);
  if (!passwordMatches) {
    throw new AuthError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }

  const user: UserResponse = {
    id: userRow.id,
    email: userRow.email,
    accountStatus: userRow.account_status,
    createdAt: userRow.created_at.toISOString(),
  };

  const { token, expiresInSeconds } = generateToken(
    { userId: user.id, email: user.email },
    jwtSecret
  );

  return { user, token, expiresIn: expiresInSeconds };
}

/**
 * Revokes a token by inserting its jti into the revoked_tokens denylist.
 */
export async function revokeToken(
  jti: string,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 86400 * 1000)
): Promise<void> {
  await query(
    `INSERT INTO revoked_tokens (jti, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, userId, expiresAt]
  );
}

/**
 * Checks whether a token has been revoked.
 */
export async function isTokenRevoked(jti: string): Promise<boolean> {
  const res = await query<{ jti: string }>(
    'SELECT jti FROM revoked_tokens WHERE jti = $1',
    [jti]
  );
  return res.rows.length > 0;
}

/**
 * Retrieves a user by their unique UUID.
 */
export async function getUserById(userId: string): Promise<UserResponse | null> {
  const res = await query<UserRecord>(
    `SELECT id, email, account_status, created_at, updated_at
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = res.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    accountStatus: row.account_status,
    createdAt: row.created_at.toISOString(),
  };
}
