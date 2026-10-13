import type { RetrievedChunk, RetrievalLatencyBreakdown } from '@devdocs/shared';

export interface LLMGenerationResult {
  content: string;
  model: string;
  provider: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  durationMs: number;
}

export interface LLMProvider {
  readonly model: string;
  readonly provider: string;
  generate(userPrompt: string, systemPrompt?: string): Promise<LLMGenerationResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'LLM_ERROR',
    public readonly statusCode: number = 502,
    public readonly isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface RAGQueryParams {
  organizationId: string;
  query: string;
  topK?: number | undefined;
  documentId?: string | undefined;
  maxContextChars?: number | undefined;
}

export interface RAGQueryResult {
  query: string;
  answer: string;
  chunks: RetrievedChunk[];
  contextChunksCount: number;
  insufficientEvidence: boolean;
  model: string;
  provider: string;
  latency: RetrievalLatencyBreakdown;
}
