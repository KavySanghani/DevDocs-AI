import type { IngestionResult } from '@devdocs/shared';

export interface ChunkInput {
  chunkIndex: number;
  content: string;
  characterCount: number;
  tokenCount: number;
  pageNumber?: number | null | undefined;
  sectionTitle?: string | null | undefined;
  filePath?: string | null | undefined;
  lineStart?: number | null | undefined;
  lineEnd?: number | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ChunkWithEmbedding extends ChunkInput {
  embedding: number[];
}

export interface ChunkingConfig {
  maxChunkSizeChars: number;
  chunkOverlapChars: number;
  minChunkSizeChars: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedChunks(texts: string[]): Promise<number[][]>;
}

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'EMBEDDING_PROVIDER_ERROR',
    public readonly statusCode: number = 502,
    public readonly isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

export type IngestionStage =
  | 'validation'
  | 'normalization'
  | 'chunking'
  | 'embedding'
  | 'persistence'
  | 'finalization';

export class IngestionError extends Error {
  constructor(
    message: string,
    public stage: IngestionStage = 'validation',
    public readonly statusCode: number = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}

export interface IngestDocumentParams {
  documentId: string;
  documentVersionId?: string | undefined;
  organizationId: string;
  provider?: EmbeddingProvider | undefined;
  config?: Partial<ChunkingConfig> | undefined;
}

export type { IngestionResult };
