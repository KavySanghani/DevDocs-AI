import { z } from 'zod';

/**
 * Standard Environment enumeration.
 */
export const EnvironmentSchema = z.enum(['development', 'test', 'production']);
export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Schema for system health response (liveness and readiness).
 * Reports application state without leaking internal infrastructure details.
 */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unhealthy']),
  timestamp: z.string(),
  uptime: z.number(),
  version: z.string(),
  environment: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Standard API error detail payload.
 */
export const ApiErrorDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
  statusCode: z.number(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

/**
 * Top-level structured error envelope.
 */
export const ApiErrorResponseSchema = z.object({
  error: ApiErrorDetailSchema,
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
