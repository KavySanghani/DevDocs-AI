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

// ==============================================================================
// Authentication & User Schemas (Phase 3)
// ==============================================================================

export const UserAccountStatusSchema = z.enum(['active', 'suspended', 'deactivated']);
export type UserAccountStatus = z.infer<typeof UserAccountStatusSchema>;

export const UserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  accountStatus: UserAccountStatusSchema,
  createdAt: z.string(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const RegisterRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must not exceed 128 characters'),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  user: UserResponseSchema,
  token: z.string(),
  expiresIn: z.number(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export interface JwtTokenPayload {
  userId: string;
  email: string;
  jti: string;
}

// ==============================================================================
// Organization & RBAC Schemas (Phase 3)
// ==============================================================================

export const OrganizationRoleSchema = z.enum(['admin', 'member', 'viewer']);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const ROLE_HIERARCHY: Record<OrganizationRole, number> = {
  admin: 3,
  member: 2,
  viewer: 1,
};

/**
 * Checks whether userRole satisfies or exceeds requiredRole.
 */
export function hasMinimumRole(
  userRole: OrganizationRole,
  requiredRole: OrganizationRole
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

export const OrganizationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: OrganizationRoleSchema.optional(),
  createdAt: z.string(),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

export const OrganizationMemberResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string(),
  role: OrganizationRoleSchema,
  joinedAt: z.string(),
});
export type OrganizationMemberResponse = z.infer<typeof OrganizationMemberResponseSchema>;

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must consist only of lowercase alphanumeric characters and hyphens')
    .optional(),
});
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const AddMemberRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  role: OrganizationRoleSchema,
});
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

export const UpdateMemberRoleRequestSchema = z.object({
  role: OrganizationRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

// ==============================================================================
// Document & Ingestion Schemas (Phase 4)
// ==============================================================================

export const DocumentSourceTypeSchema = z.enum(['pdf', 'markdown', 'text', 'github']);
export type DocumentSourceType = z.infer<typeof DocumentSourceTypeSchema>;

export const DocumentStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed']);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentVersionSummarySchema = z.object({
  id: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  contentHash: z.string(),
  status: DocumentStatusSchema,
  errorMessage: z.string().nullable().optional(),
  chunkCount: z.number().int().optional(),
  characterCount: z.number().int().optional(),
  isCurrent: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentVersionSummary = z.infer<typeof DocumentVersionSummarySchema>;

export const DocumentResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  createdBy: z.string().uuid().nullable().optional(),
  name: z.string(),
  sourceType: DocumentSourceTypeSchema,
  currentVersionId: z.string().uuid().nullable().optional(),
  status: DocumentStatusSchema,
  currentVersion: DocumentVersionSummarySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

export const DocumentDetailResponseSchema = DocumentResponseSchema.extend({
  versions: z.array(DocumentVersionSummarySchema).optional(),
  sourceDetails: z
    .object({
      originalFilename: z.string().optional(),
      mimeType: z.string().optional(),
      fileSizeBytes: z.number().optional(),
      characterCount: z.number().optional(),
      wordCount: z.number().optional(),
      pageCount: z.number().optional(),
    })
    .passthrough()
    .optional(),
});
export type DocumentDetailResponse = z.infer<typeof DocumentDetailResponseSchema>;

export const DocumentVersionListResponseSchema = z.object({
  documentId: z.string().uuid(),
  currentVersionId: z.string().uuid().nullable().optional(),
  versions: z.array(DocumentVersionSummarySchema),
});
export type DocumentVersionListResponse = z.infer<typeof DocumentVersionListResponseSchema>;

export const ActivateVersionResponseSchema = z.object({
  success: z.boolean(),
  documentId: z.string().uuid(),
  previousVersionId: z.string().uuid().nullable().optional(),
  currentVersionId: z.string().uuid(),
  message: z.string(),
});
export type ActivateVersionResponse = z.infer<typeof ActivateVersionResponseSchema>;

export const DocumentReindexRequestSchema = z.object({
  versionId: z.string().uuid().optional(),
  config: z
    .object({
      maxChunkSizeChars: z.number().int().positive().optional(),
      chunkOverlapChars: z.number().int().min(0).optional(),
      minChunkSizeChars: z.number().int().positive().optional(),
    })
    .optional(),
});
export type DocumentReindexRequest = z.infer<typeof DocumentReindexRequestSchema>;

export const DocumentReindexResponseSchema = z.object({
  success: z.boolean(),
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  status: DocumentStatusSchema,
  chunkCount: z.number().int(),
  totalCharacters: z.number().int(),
  totalEstimatedTokens: z.number().int(),
  embeddingModel: z.string(),
  reindexedAt: z.string(),
});
export type DocumentReindexResponse = z.infer<typeof DocumentReindexResponseSchema>;

export const DocumentDiffQuerySchema = z.object({
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
});
export type DocumentDiffQuery = z.infer<typeof DocumentDiffQuerySchema>;

export const DiffChunkSchema = z.object({
  type: z.enum(['added', 'removed', 'unchanged']),
  text: z.string(),
  lineStart: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
});
export type DiffChunk = z.infer<typeof DiffChunkSchema>;

export const DocumentDiffResponseSchema = z.object({
  documentId: z.string().uuid(),
  documentName: z.string(),
  fromVersion: z.object({
    id: z.string().uuid(),
    versionNumber: z.number().int(),
    contentHash: z.string(),
    status: DocumentStatusSchema,
    createdAt: z.string(),
  }),
  toVersion: z.object({
    id: z.string().uuid(),
    versionNumber: z.number().int(),
    contentHash: z.string(),
    status: DocumentStatusSchema,
    createdAt: z.string(),
  }),
  isContentIdentical: z.boolean(),
  characterCountDelta: z.number().int(),
  chunkCountDelta: z.number().int(),
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  linesUnchanged: z.number().int(),
  unifiedDiff: z.string(),
  chunks: z.array(DiffChunkSchema),
  sections: z
    .object({
      added: z.array(z.string()),
      removed: z.array(z.string()),
      unchanged: z.array(z.string()),
    })
    .optional(),
});
export type DocumentDiffResponse = z.infer<typeof DocumentDiffResponseSchema>;

export const DocumentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sourceType: DocumentSourceTypeSchema.optional(),
  status: DocumentStatusSchema.optional(),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuerySchema>;

// ==============================================================================
// Chunking, Embeddings & Ingestion Schemas (Phase 5)
// ==============================================================================

export const ChunkResponseSchema = z.object({
  id: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  chunkIndex: z.number().int().min(0),
  content: z.string(),
  tokenCount: z.number().int().nullable().optional(),
  characterCount: z.number().int(),
  pageNumber: z.number().int().nullable().optional(),
  sectionTitle: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  lineStart: z.number().int().nullable().optional(),
  lineEnd: z.number().int().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type ChunkResponse = z.infer<typeof ChunkResponseSchema>;

export const ChunkListResponseSchema = z.object({
  chunks: z.array(ChunkResponseSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  totalPages: z.number().int().min(1),
});
export type ChunkListResponse = z.infer<typeof ChunkListResponseSchema>;

export const ChunkingConfigSchema = z.object({
  maxChunkSizeChars: z.number().int().positive().default(800),
  chunkOverlapChars: z.number().int().min(0).default(120),
  minChunkSizeChars: z.number().int().positive().default(50),
});
export type ChunkingConfig = z.infer<typeof ChunkingConfigSchema>;

export const IngestionResultSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  status: DocumentStatusSchema,
  chunkCount: z.number().int().min(0),
  totalCharacters: z.number().int().min(0),
  totalEstimatedTokens: z.number().int().min(0),
  embeddingModel: z.string(),
  durationMs: z.number().int().min(0),
  errorMessage: z.string().nullable().optional(),
});
export type IngestionResult = z.infer<typeof IngestionResultSchema>;

// ==============================================================================
// Vector Search & Retrieval Schemas (Phase 6) & Hybrid Search / RRF (Phase 7)
// ==============================================================================

export const RetrievalModeSchema = z.enum(['hybrid', 'vector', 'keyword']);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

export const RetrievedChunkSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentName: z.string(),
  documentVersionId: z.string().uuid(),
  chunkIndex: z.number().int().min(0),
  content: z.string(),
  characterCount: z.number().int().min(0),
  tokenCount: z.number().int().nullable().optional(),
  pageNumber: z.number().int().nullable().optional(),
  sectionTitle: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  lineStart: z.number().int().nullable().optional(),
  lineEnd: z.number().int().nullable().optional(),
  similarityScore: z.number().optional(),
  distance: z.number().optional(),
  rank: z.number().int().min(1),
  metadata: z.record(z.unknown()).optional(),
  // Phase 7 diagnostics
  score: z.number().optional(),
  vectorRank: z.number().int().min(1).nullable().optional(),
  vectorScore: z.number().nullable().optional(),
  lexicalRank: z.number().int().min(1).nullable().optional(),
  lexicalScore: z.number().nullable().optional(),
  rrfScore: z.number().nullable().optional(),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const RetrievalLatencyBreakdownSchema = z.object({
  embeddingMs: z.number().min(0),
  retrievalMs: z.number().min(0),
  generationMs: z.number().min(0).optional(),
  fusionMs: z.number().min(0).optional(),
  totalMs: z.number().min(0),
});
export type RetrievalLatencyBreakdown = z.infer<typeof RetrievalLatencyBreakdownSchema>;

export const VectorSearchRequestSchema = z.object({
  query: z
    .string()
    .min(1, 'Query must not be empty')
    .max(2000, 'Query exceeds 2000 character limit')
    .transform((q) => q.trim()),
  topK: z.coerce.number().int().min(1).max(50).default(5),
  documentId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  similarityThreshold: z.coerce.number().min(0).max(1).optional(),
});
export type VectorSearchRequest = z.infer<typeof VectorSearchRequestSchema>;

export const VectorSearchResponseSchema = z.object({
  query: z.string(),
  chunks: z.array(RetrievedChunkSchema),
  totalCandidates: z.number().int().min(0),
  embeddingModel: z.string(),
  latency: RetrievalLatencyBreakdownSchema,
});
export type VectorSearchResponse = z.infer<typeof VectorSearchResponseSchema>;

export const SearchRequestSchema = z.object({
  query: z
    .string()
    .min(1, 'Query must not be empty')
    .max(2000, 'Query exceeds 2000 character limit')
    .transform((q) => q.trim()),
  organizationId: z.string().uuid().optional(),
  mode: RetrievalModeSchema.default('hybrid'),
  retrievalMode: RetrievalModeSchema.optional(),
  topK: z.coerce.number().int().min(1).max(50).default(5),
  candidateCount: z.coerce.number().int().min(1).max(100).default(20),
  documentId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  similarityThreshold: z.coerce.number().min(0).max(1).optional(),
  rrfK: z.coerce.number().int().min(1).max(500).default(60),
  metadataFilter: z.record(z.unknown()).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  mode: RetrievalModeSchema,
  chunks: z.array(RetrievedChunkSchema),
  totalCandidates: z.number().int().min(0),
  embeddingModel: z.string().optional(),
  rrfK: z.number().int().optional(),
  latency: RetrievalLatencyBreakdownSchema,
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const RAGQueryRequestSchema = z.object({
  query: z
    .string()
    .min(1, 'Query must not be empty')
    .max(2000, 'Query exceeds 2000 character limit')
    .transform((q) => q.trim()),
  mode: RetrievalModeSchema.default('hybrid').optional(),
  topK: z.coerce.number().int().min(1).max(20).default(5),
  documentId: z.string().uuid().optional(),
  maxContextChars: z.coerce.number().int().min(500).max(50000).optional(),
});
export type RAGQueryRequest = z.infer<typeof RAGQueryRequestSchema>;

export const RAGQueryResponseSchema = z.object({
  query: z.string(),
  answer: z.string(),
  chunks: z.array(RetrievedChunkSchema),
  contextChunksCount: z.number().int().min(0),
  insufficientEvidence: z.boolean(),
  model: z.string(),
  provider: z.string(),
  latency: RetrievalLatencyBreakdownSchema,
});
export type RAGQueryResponse = z.infer<typeof RAGQueryResponseSchema>;

// ==============================================================================
// Grounded Chat & Citations Schemas (Phase 8)
// ==============================================================================

export const ChatMessageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

export const CitationResponseSchema = z.object({
  id: z.string().uuid().optional(),
  citationNumber: z.number().int().min(1),
  chunkId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  documentName: z.string(),
  pageNumber: z.number().int().nullable().optional(),
  sectionTitle: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  lineStart: z.number().int().nullable().optional(),
  lineEnd: z.number().int().nullable().optional(),
  snippet: z.string().nullable().optional(),
  sourceDeleted: z.boolean().optional(),
});
export type CitationResponse = z.infer<typeof CitationResponseSchema>;

export const ChatMessageResponseSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: ChatMessageRoleSchema,
  content: z.string(),
  retrievalRunId: z.string().uuid().nullable().optional(),
  citations: z.array(CitationResponseSchema).optional(),
  createdAt: z.string(),
});
export type ChatMessageResponse = z.infer<typeof ChatMessageResponseSchema>;

export const ChatSessionResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid().nullable().optional(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSessionResponse = z.infer<typeof ChatSessionResponseSchema>;

export const ChatSessionDetailResponseSchema = z.object({
  session: ChatSessionResponseSchema,
  messages: z.array(ChatMessageResponseSchema),
});
export type ChatSessionDetailResponse = z.infer<typeof ChatSessionDetailResponseSchema>;

export const ChatSessionListResponseSchema = z.object({
  sessions: z.array(ChatSessionResponseSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  totalPages: z.number().int().min(1),
});
export type ChatSessionListResponse = z.infer<typeof ChatSessionListResponseSchema>;

export const CreateChatSessionRequestSchema = z.object({
  organizationId: z.string().uuid().optional(),
  title: z.string().min(1).max(255).optional(),
});
export type CreateChatSessionRequest = z.infer<typeof CreateChatSessionRequestSchema>;

export const CreateChatMessageRequestSchema = z.object({
  content: z
    .string()
    .min(1, 'Message content must not be empty')
    .max(4000, 'Message content exceeds 4000 character limit')
    .transform((c) => c.trim()),
  mode: RetrievalModeSchema.default('hybrid').optional(),
  topK: z.coerce.number().int().min(1).max(20).default(5).optional(),
  documentId: z.string().uuid().optional(),
  maxContextChars: z.coerce.number().int().min(500).max(50000).optional(),
});
export type CreateChatMessageRequest = z.infer<typeof CreateChatMessageRequestSchema>;

export const ChatMessageTurnResponseSchema = z.object({
  userMessage: ChatMessageResponseSchema,
  assistantMessage: ChatMessageResponseSchema,
  citations: z.array(CitationResponseSchema),
  retrieval: z.object({
    runId: z.string().uuid().optional(),
    retriever: z.string(),
    candidateCount: z.number().int().min(0),
    topK: z.number().int().min(1),
    chunks: z.array(RetrievedChunkSchema),
  }),
  insufficientEvidence: z.boolean(),
  latency: RetrievalLatencyBreakdownSchema,
});
export type ChatMessageTurnResponse = z.infer<typeof ChatMessageTurnResponseSchema>;

export const ChunkSourceResponseSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentName: z.string(),
  documentVersionId: z.string().uuid(),
  chunkIndex: z.number().int().min(0),
  content: z.string(),
  characterCount: z.number().int().min(0),
  tokenCount: z.number().int().nullable().optional(),
  pageNumber: z.number().int().nullable().optional(),
  sectionTitle: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  lineStart: z.number().int().nullable().optional(),
  lineEnd: z.number().int().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type ChunkSourceResponse = z.infer<typeof ChunkSourceResponseSchema>;
