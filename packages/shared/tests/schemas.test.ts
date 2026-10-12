import { describe, it, expect } from 'vitest';
import { HealthResponseSchema, ApiErrorResponseSchema, EnvironmentSchema } from '../src/index.js';

describe('Shared Schemas', () => {
  describe('EnvironmentSchema', () => {
    it('accepts valid environments', () => {
      expect(EnvironmentSchema.parse('development')).toBe('development');
      expect(EnvironmentSchema.parse('test')).toBe('test');
      expect(EnvironmentSchema.parse('production')).toBe('production');
    });

    it('rejects invalid environment strings', () => {
      expect(() => EnvironmentSchema.parse('staging')).toThrow();
    });
  });

  describe('HealthResponseSchema', () => {
    it('validates a correct health payload', () => {
      const valid = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: 12.34,
        version: '0.1.0',
        environment: 'development',
      };
      const result = HealthResponseSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects payload missing required fields', () => {
      const invalid = { status: 'ok' };
      const result = HealthResponseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('ApiErrorResponseSchema', () => {
    it('validates standard error envelope', () => {
      const errorObj = {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          statusCode: 404,
          requestId: 'req-abc-123',
        },
      };
      const result = ApiErrorResponseSchema.safeParse(errorObj);
      expect(result.success).toBe(true);
    });
  });
});
