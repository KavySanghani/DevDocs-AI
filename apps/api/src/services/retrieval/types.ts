import type { RetrievedChunk, RetrievalLatencyBreakdown } from '@devdocs/shared';

export interface VectorSearchParams {
  organizationId: string;
  query: string;
  topK?: number | undefined;
  documentId?: string | undefined;
  similarityThreshold?: number | undefined;
}

export interface VectorSearchResult {
  query: string;
  chunks: RetrievedChunk[];
  totalCandidates: number;
  embeddingModel: string;
  latency: RetrievalLatencyBreakdown;
}

export class RetrievalError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'RETRIEVAL_ERROR',
    public readonly statusCode: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'RetrievalError';
  }
}
