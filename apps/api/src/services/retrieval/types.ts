import type {
  RetrievedChunk,
  RetrievalLatencyBreakdown,
  RetrievalMode,
} from '@devdocs/shared';

export type { RetrievalMode };

export interface VectorSearchParams {
  organizationId: string;
  query: string;
  topK?: number | undefined;
  documentId?: string | undefined;
  versionId?: string | undefined;
  similarityThreshold?: number | undefined;
  metadataFilter?: Record<string, unknown> | undefined;
}

export interface VectorSearchResult {
  query: string;
  chunks: RetrievedChunk[];
  totalCandidates: number;
  embeddingModel: string;
  latency: RetrievalLatencyBreakdown;
}

export interface LexicalSearchParams {
  organizationId: string;
  query: string;
  topK?: number | undefined;
  documentId?: string | undefined;
  versionId?: string | undefined;
  metadataFilter?: Record<string, unknown> | undefined;
}

export interface LexicalSearchResult {
  query: string;
  chunks: RetrievedChunk[];
  totalCandidates: number;
  latency: {
    retrievalMs: number;
    totalMs: number;
  };
}

export interface HybridSearchParams {
  organizationId: string;
  query: string;
  mode?: RetrievalMode | undefined;
  topK?: number | undefined;
  candidateCount?: number | undefined;
  documentId?: string | undefined;
  versionId?: string | undefined;
  similarityThreshold?: number | undefined;
  rrfK?: number | undefined;
  metadataFilter?: Record<string, unknown> | undefined;
}

export interface HybridSearchResult {
  query: string;
  mode: RetrievalMode;
  chunks: RetrievedChunk[];
  totalCandidates: number;
  embeddingModel?: string | undefined;
  rrfK?: number | undefined;
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
