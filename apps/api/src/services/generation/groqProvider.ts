import type { ApiEnv } from '../../config/env.js';
import { type LLMGenerationResult, type LLMProvider, LLMError } from './types.js';

export interface GroqProviderOptions {
  apiKey: string;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  baseUrl?: string | undefined;
}

export interface MockLLMProviderOptions {
  model?: string | undefined;
  simulatedResponse?: string | undefined;
  simulatedError?: string | null | undefined;
  simulatedDelayMs?: number | undefined;
}

/**
 * Groq LLM Provider using native Node 22 fetch.
 * Redacts secrets from error messages and applies strict timeout abort signals.
 */
export class GroqProvider implements LLMProvider {
  readonly model: string;
  readonly provider: string = 'groq';
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: GroqProviderOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new LLMError('Groq API key is required', 'MISSING_API_KEY', 500);
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model ?? 'llama-3.3-70b-versatile';
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.baseUrl = (options.baseUrl ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  }

  async generate(userPrompt: string, systemPrompt?: string): Promise<LLMGenerationResult> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (systemPrompt && systemPrompt.trim().length > 0) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: userPrompt });

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.1,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const sanitizedError = this.sanitizeErrorMessage(errorText);

        if (response.status === 429) {
          throw new LLMError(
            `Groq rate limit exceeded: ${sanitizedError}`,
            'RATE_LIMIT_EXCEEDED',
            429,
            true
          );
        }

        if (response.status === 401 || response.status === 403) {
          throw new LLMError(
            'Groq API authentication failed. Verify GROQ_API_KEY.',
            'AUTHENTICATION_ERROR',
            502
          );
        }

        throw new LLMError(
          `Groq API request failed with status ${response.status}: ${sanitizedError}`,
          'PROVIDER_ERROR',
          response.status >= 500 ? 502 : 400,
          response.status >= 500
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LLMError('Groq returned malformed response: missing choices[0].message.content', 'MALFORMED_RESPONSE', 502);
      }

      const durationMs = Math.max(0, Date.now() - startTime);

      return {
        content: content.trim(),
        model: this.model,
        provider: this.provider,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        durationMs,
      };
    } catch (err) {
      if (err instanceof LLMError) {
        throw err;
      }

      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        throw new LLMError(
          `Groq request timed out after ${this.timeoutMs}ms`,
          'REQUEST_TIMEOUT',
          504,
          true
        );
      }

      const message = err instanceof Error ? this.sanitizeErrorMessage(err.message) : 'Unknown LLM network failure';
      throw new LLMError(`Groq request failed: ${message}`, 'NETWORK_ERROR', 502, true);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private sanitizeErrorMessage(message: string): string {
    return message
      .replace(/gsk_[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
      .slice(0, 500);
  }
}

/**
 * Deterministic mock LLM provider for unit tests and local execution without Groq credentials.
 */
export class MockLLMProvider implements LLMProvider {
  readonly model: string;
  readonly provider: string = 'mock';
  private readonly simulatedResponse?: string | undefined;
  private readonly simulatedError?: string | null | undefined;
  private readonly simulatedDelayMs?: number | undefined;

  constructor(options: MockLLMProviderOptions = {}) {
    this.model = options.model ?? 'mock-llama-3.3-70b-versatile';
    this.simulatedResponse = options.simulatedResponse;
    this.simulatedError = options.simulatedError;
    this.simulatedDelayMs = options.simulatedDelayMs;
  }

  async generate(userPrompt: string, _systemPrompt?: string): Promise<LLMGenerationResult> {
    const startTime = Date.now();

    if (this.simulatedDelayMs && this.simulatedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedDelayMs));
    }

    if (this.simulatedError) {
      throw new LLMError(`Mock LLM failure: ${this.simulatedError}`, 'PROVIDER_ERROR', 502);
    }

    if (this.simulatedResponse) {
      return {
        content: this.simulatedResponse,
        model: this.model,
        provider: this.provider,
        promptTokens: 100,
        completionTokens: 50,
        durationMs: Math.max(0, Date.now() - startTime),
      };
    }

    // Default intelligent mock response extracting facts from prompt
    const durationMs = Math.max(0, Date.now() - startTime);

    if (userPrompt.includes('REFERENCE DOCUMENTATION:\n==================================================\n==================================================')) {
      return {
        content: 'I cannot answer this question based on the provided documentation.',
        model: this.model,
        provider: this.provider,
        promptTokens: 50,
        completionTokens: 15,
        durationMs,
      };
    }

    // Extract first 200 characters of reference documentation to synthesize an answer
    const refMatch = userPrompt.match(/REFERENCE DOCUMENTATION:\n={20,}\n([\s\S]*?)\n={20,}/);
    const refContent = refMatch ? refMatch[1]?.trim() : '';

    if (!refContent) {
      return {
        content: 'I cannot answer this question based on the provided documentation.',
        model: this.model,
        provider: this.provider,
        promptTokens: 50,
        completionTokens: 15,
        durationMs,
      };
    }

    // Synthesize grounded answer
    const firstLine = refContent.split('\n').find((l) => l.trim().length > 10 && !l.startsWith('[')) || 'The requested feature is configured according to the provided documentation.';
    const synthesizedAnswer = `Based on the provided documentation, ${firstLine.trim()}`;

    return {
      content: synthesizedAnswer,
      model: this.model,
      provider: this.provider,
      promptTokens: 120,
      completionTokens: 35,
      durationMs,
    };
  }
}

/**
 * Creates an LLMProvider instance based on application configuration.
 */
export function createLLMProvider(env: ApiEnv): LLMProvider {
  if (env.LLM_PROVIDER === 'groq') {
    if (!env.GROQ_API_KEY || env.GROQ_API_KEY.trim() === '') {
      if (env.NODE_ENV === 'test') {
        return new MockLLMProvider({
          model: env.GROQ_MODEL,
        });
      }
      throw new LLMError(
        'GROQ_API_KEY is required when LLM_PROVIDER is "groq"',
        'MISSING_API_KEY',
        500
      );
    }

    return new GroqProvider({
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL,
      timeoutMs: env.GROQ_TIMEOUT_MS,
    });
  }

  return new MockLLMProvider({
    model: env.GROQ_MODEL,
  });
}
