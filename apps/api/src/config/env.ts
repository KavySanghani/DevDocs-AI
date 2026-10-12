import { config } from 'dotenv';
import { z } from 'zod';
import { EnvironmentSchema } from '@devdocs/shared';

// Load environment variables from .env if present
config();

export const ApiEnvSchema = z.object({
  PORT: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(65535)),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: EnvironmentSchema.default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Deferred Phase Placeholders (optional in Phase 1)
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

let parsedEnv: ApiEnv | null = null;

/**
 * Validates provided environment record or falls back to process.env.
 * Throws a detailed Error if validation fails.
 */
export function validateEnv(input: Record<string, unknown> = process.env): ApiEnv {
  const result = ApiEnvSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  return result.data;
}

/**
 * Retrieves the validated environment config, caching the result.
 */
export function getEnv(): ApiEnv {
  if (!parsedEnv) {
    parsedEnv = validateEnv(process.env);
  }
  return parsedEnv;
}
