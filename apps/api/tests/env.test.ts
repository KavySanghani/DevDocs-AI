import { describe, it, expect } from 'vitest';
import { validateEnv } from '../src/config/env.js';

describe('Environment Validation', () => {
  it('parses valid environment configurations with defaults', () => {
    const env = validateEnv({});
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
  });

  it('coerces and validates custom valid PORT', () => {
    const env = validateEnv({ PORT: '5050' });
    expect(env.PORT).toBe(5050);
  });

  it('rejects invalid PORT string', () => {
    expect(() => validateEnv({ PORT: 'not-a-number' })).toThrow();
  });

  it('rejects out of bounds PORT number', () => {
    expect(() => validateEnv({ PORT: '99999' })).toThrow();
  });

  it('rejects unsupported NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow();
  });

  it('accepts optional placeholder variables', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      JWT_SECRET: 'test-secret',
    });
    expect(env.DATABASE_URL).toBe('postgresql://localhost:5432/test');
    expect(env.JWT_SECRET).toBe('test-secret');
  });
});
