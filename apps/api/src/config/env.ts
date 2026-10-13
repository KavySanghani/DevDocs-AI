import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';
import { EnvironmentSchema } from '@devdocs/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate and load root .env reliably across monorepo and workspace execution
const rootEnvPath = path.resolve(__dirname, '../../../../.env');
if (fs.existsSync(rootEnvPath)) {
  config({ path: rootEnvPath });
}
config();

export const ApiEnvSchema = z
  .object({
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

    // Database & Vector Storage (Phase 2)
    DATABASE_URL: z.string().optional(),

    // Authentication & Tenant RBAC (Phase 3)
    JWT_SECRET: z
      .string()
      .min(8, 'JWT_SECRET must be at least 8 characters')
      .default('devdocs_dev_secret_key_32_characters_minimum!'),
    JWT_EXPIRES_IN: z.string().default('24h'),

    // Document Ingestion Configuration (Phase 4)
    MAX_FILE_SIZE_BYTES: z
      .string()
      .default('10485760')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),

    // Chunking & Embedding Pipeline (Phase 5)
    EMBEDDING_PROVIDER: z.enum(['openai', 'mock']).default('openai'),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    EMBEDDING_DIMENSIONS: z
      .string()
      .default('1536')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),
    CHUNK_SIZE_CHARS: z
      .string()
      .default('800')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),
    CHUNK_OVERLAP_CHARS: z
      .string()
      .default('120')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().min(0)),
    EMBEDDING_BATCH_SIZE: z
      .string()
      .default('100')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),
    EMBEDDING_TIMEOUT_MS: z
      .string()
      .default('30000')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),

    // Vector Retrieval & Groq LLM Generation Pipeline (Phase 6)
    LLM_PROVIDER: z.enum(['groq', 'mock']).default('groq'),
    GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
    GROQ_TIMEOUT_MS: z
      .string()
      .default('30000')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),
    RAG_MAX_CONTEXT_CHARS: z
      .string()
      .default('12000')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),
    RAG_MAX_TOP_K: z
      .string()
      .default('20')
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive()),

    // External Provider Keys & Deferred Infrastructure
    OPENAI_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().optional(),
    REDIS_URL: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (
        !data.JWT_SECRET ||
        data.JWT_SECRET === 'devdocs_dev_secret_key_32_characters_minimum!' ||
        data.JWT_SECRET.length < 32
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'JWT_SECRET must be set to a secure custom secret with at least 32 characters in production.',
          path: ['JWT_SECRET'],
        });
      }

      if (data.EMBEDDING_PROVIDER === 'openai' && (!data.OPENAI_API_KEY || data.OPENAI_API_KEY.trim() === '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'OPENAI_API_KEY is required in production when EMBEDDING_PROVIDER is set to "openai".',
          path: ['OPENAI_API_KEY'],
        });
      }

      if (data.LLM_PROVIDER === 'groq' && (!data.GROQ_API_KEY || data.GROQ_API_KEY.trim() === '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'GROQ_API_KEY is required in production when LLM_PROVIDER is set to "groq".',
          path: ['GROQ_API_KEY'],
        });
      }
    }
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

/**
 * Overrides the cached environment (used for tests and app factories).
 */
export function setEnv(env: ApiEnv): void {
  parsedEnv = env;
}

/**
 * Resets the cached environment, forcing re-validation on next getEnv() call.
 */
export function resetEnv(): void {
  parsedEnv = null;
}
