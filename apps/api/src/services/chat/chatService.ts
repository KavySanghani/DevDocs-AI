import { query } from '@devdocs/db';
import type {
  ChatMessageResponse,
  ChatMessageTurnResponse,
  ChatSessionDetailResponse,
  ChatSessionListResponse,
  ChatSessionResponse,
  ChunkSourceResponse,
  CitationResponse,
  RetrievalMode,
} from '@devdocs/shared';
import { getEnv } from '../../config/env.js';
import type { EmbeddingProvider } from '../ingestion/types.js';
import { createLLMProvider } from '../generation/groqProvider.js';
import type { LLMProvider } from '../generation/types.js';
import { getOrganizationMember } from '../organizationService.js';
import { searchHybridChunks } from '../retrieval/hybridSearch.js';
import { buildChatPrompt } from './chatPromptBuilder.js';
import { validateAndSanitizeCitations } from './citationValidator.js';
import { rewriteQueryForChat } from './queryRewriter.js';

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'CHAT_ERROR',
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatServiceOptions {
  embeddingProvider?: EmbeddingProvider | undefined;
  llmProvider?: LLMProvider | undefined;
}

interface ChatSessionRow {
  id: string;
  organization_id: string;
  user_id: string | null;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  retrieval_run_id: string | null;
  created_at: Date;
}

interface CitationRow {
  id: string;
  message_id: string;
  chunk_id: string | null;
  citation_number: number;
  document_id: string | null;
  document_name: string;
  page_number: number | null;
  section_title: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  snippet: string | null;
  created_at: Date;
}

/**
 * Creates a new chat session scoped to an authorized organization.
 */
export async function createChatSession(params: {
  organizationId: string;
  userId: string;
  title?: string | undefined;
}): Promise<ChatSessionResponse> {
  const member = await getOrganizationMember(params.organizationId, params.userId);
  if (!member) {
    throw new ChatError('Forbidden: Not a member of this organization', 'FORBIDDEN', 403);
  }

  const title = params.title?.trim() || 'New Conversation';

  const res = await query<ChatSessionRow>(
    `INSERT INTO chat_sessions (organization_id, user_id, title)
     VALUES ($1, $2, $3)
     RETURNING id, organization_id, user_id, title, created_at, updated_at`,
    [params.organizationId, params.userId, title]
  );

  const row = res.rows[0]!;
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Lists the authenticated user's chat sessions in a specified organization.
 */
export async function listChatSessions(params: {
  organizationId: string;
  userId: string;
  page?: number | undefined;
  limit?: number | undefined;
}): Promise<ChatSessionListResponse> {
  const member = await getOrganizationMember(params.organizationId, params.userId);
  if (!member) {
    throw new ChatError('Forbidden: Not a member of this organization', 'FORBIDDEN', 403);
  }

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const offset = (page - 1) * limit;

  const countRes = await query<{ count: string }>(
    `SELECT count(*) FROM chat_sessions
     WHERE organization_id = $1 AND user_id = $2`,
    [params.organizationId, params.userId]
  );
  const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

  const sessionsRes = await query<ChatSessionRow>(
    `SELECT id, organization_id, user_id, title, created_at, updated_at
     FROM chat_sessions
     WHERE organization_id = $1 AND user_id = $2
     ORDER BY updated_at DESC
     LIMIT $3 OFFSET $4`,
    [params.organizationId, params.userId, limit, offset]
  );

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    sessions: sessionsRes.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })),
    total,
    page,
    limit,
    totalPages,
  };
}

/**
 * Retrieves a chat session by ID, including its conversation messages and citations.
 * Enforces tenant boundary and user ownership/membership.
 */
export async function getChatSession(
  sessionId: string,
  userId: string,
  organizationId?: string | undefined
): Promise<ChatSessionDetailResponse> {
  const sessionRes = await query<ChatSessionRow>(
    `SELECT id, organization_id, user_id, title, created_at, updated_at
     FROM chat_sessions
     WHERE id = $1`,
    [sessionId]
  );

  if (sessionRes.rows.length === 0) {
    throw new ChatError('Chat session not found', 'NOT_FOUND', 404);
  }

  const session = sessionRes.rows[0]!;

  // Optional orgId check if provided
  if (organizationId && session.organization_id !== organizationId) {
    throw new ChatError('Chat session not found in this organization', 'NOT_FOUND', 404);
  }

  // Tenant authorization: user must be member of organization
  const member = await getOrganizationMember(session.organization_id, userId);
  if (!member) {
    throw new ChatError('Chat session not found', 'NOT_FOUND', 404);
  }

  // Session ownership check: user must own session or be admin
  if (session.user_id && session.user_id !== userId && member.role !== 'admin') {
    throw new ChatError('Chat session not found', 'NOT_FOUND', 404);
  }

  // Fetch conversation messages
  const msgRes = await query<MessageRow>(
    `SELECT id, session_id, role, content, retrieval_run_id, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  // Fetch citations for all messages in this session
  const messageIds = msgRes.rows.map((m) => m.id);
  const citationsByMessageId = new Map<string, CitationResponse[]>();

  if (messageIds.length > 0) {
    const citeRes = await query<CitationRow>(
      `SELECT id, message_id, chunk_id, citation_number, document_id, document_name,
              page_number, section_title, file_path, line_start, line_end, snippet, created_at
       FROM citations
       WHERE message_id = ANY($1::uuid[])
       ORDER BY citation_number ASC`,
      [messageIds]
    );

    for (const c of citeRes.rows) {
      const sourceDeleted = !c.chunk_id || !c.document_id;
      const list = citationsByMessageId.get(c.message_id) ?? [];
      list.push({
        id: c.id,
        citationNumber: c.citation_number,
        chunkId: c.chunk_id ?? undefined,
        documentId: c.document_id ?? undefined,
        documentName: c.document_name,
        pageNumber: c.page_number,
        sectionTitle: c.section_title,
        filePath: c.file_path,
        lineStart: c.line_start,
        lineEnd: c.line_end,
        snippet: c.snippet,
        sourceDeleted: sourceDeleted ? true : undefined,
      });
      citationsByMessageId.set(c.message_id, list);
    }
  }

  const messages: ChatMessageResponse[] = msgRes.rows.map((m) => ({
    id: m.id,
    sessionId: m.session_id,
    role: m.role,
    content: m.content,
    retrievalRunId: m.retrieval_run_id,
    citations: citationsByMessageId.get(m.id) || [],
    createdAt: m.created_at.toISOString(),
  }));

  return {
    session: {
      id: session.id,
      organizationId: session.organization_id,
      userId: session.user_id,
      title: session.title,
      createdAt: session.created_at.toISOString(),
      updatedAt: session.updated_at.toISOString(),
    },
    messages,
  };
}

/**
 * Submits a user question to a chat session, executes grounded retrieval,
 * validates citations, records the conversational turn, and returns a verified answer.
 */
export async function postChatMessage(
  params: {
    sessionId: string;
    userId: string;
    content: string;
    mode?: RetrievalMode | undefined;
    topK?: number | undefined;
    documentId?: string | undefined;
    maxContextChars?: number | undefined;
  },
  options: ChatServiceOptions = {}
): Promise<ChatMessageTurnResponse> {
  const env = getEnv();
  const sanitizedContent = params.content.trim();
  if (!sanitizedContent) {
    throw new ChatError('Message content must not be empty', 'VALIDATION_ERROR', 400);
  }

  // 1. Verify session and access
  const sessionRes = await query<ChatSessionRow>(
    `SELECT id, organization_id, user_id, title, created_at, updated_at
     FROM chat_sessions
     WHERE id = $1`,
    [params.sessionId]
  );

  if (sessionRes.rows.length === 0) {
    throw new ChatError('Chat session not found', 'NOT_FOUND', 404);
  }

  const session = sessionRes.rows[0]!;
  const member = await getOrganizationMember(session.organization_id, params.userId);
  if (!member) {
    throw new ChatError('Chat session not found', 'NOT_FOUND', 404);
  }

  if (session.user_id && session.user_id !== params.userId && member.role !== 'admin') {
    throw new ChatError('Chat session not found', 'NOT_FOUND', 404);
  }

  // 2. Insert user turn into messages
  const userMsgRes = await query<MessageRow>(
    `INSERT INTO messages (session_id, role, content)
     VALUES ($1, 'user', $2)
     RETURNING id, session_id, role, content, retrieval_run_id, created_at`,
    [params.sessionId, sanitizedContent]
  );
  const userMsg = userMsgRes.rows[0]!;

  // 3. Update session updated_at and title if initial
  if (session.title === 'New Conversation') {
    const previewTitle =
      sanitizedContent.length > 40 ? sanitizedContent.slice(0, 40) + '...' : sanitizedContent;
    await query(
      `UPDATE chat_sessions SET title = $1, updated_at = now() WHERE id = $2`,
      [previewTitle, params.sessionId]
    );
  } else {
    await query(`UPDATE chat_sessions SET updated_at = now() WHERE id = $1`, [params.sessionId]);
  }

  // 4. Fetch bounded recent history (excluding this new user turn) for query rewriting
  const historyRes = await query<MessageRow>(
    `SELECT id, session_id, role, content, retrieval_run_id, created_at
     FROM messages
     WHERE session_id = $1 AND id != $2
     ORDER BY created_at DESC
     LIMIT 4`,
    [params.sessionId, userMsg.id]
  );
  const recentHistory = historyRes.rows.reverse();

  // 5. Query rewriting
  const llmProvider = options.llmProvider ?? createLLMProvider(env);
  const rewrittenQuery = await rewriteQueryForChat({
    currentQuery: sanitizedContent,
    history: recentHistory,
    llmProvider,
  });

  // 6. Hybrid retrieval across tenant sources
  const retrievalMode = params.mode ?? 'hybrid';
  const topK = Math.min(20, Math.max(1, params.topK ?? 5));

  const retrievalResult = await searchHybridChunks(
    {
      organizationId: session.organization_id,
      query: rewrittenQuery,
      mode: retrievalMode,
      topK,
      documentId: params.documentId,
    },
    options.embeddingProvider
  );

  // 7. Persist retrieval_runs record
  const runRes = await query<{ id: string }>(
    `INSERT INTO retrieval_runs (
       organization_id, query, rewritten_query, retriever, configuration, latency_ms, candidate_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      session.organization_id,
      sanitizedContent,
      rewrittenQuery !== sanitizedContent ? rewrittenQuery : null,
      retrievalMode,
      JSON.stringify({
        topK,
        documentId: params.documentId ?? null,
        mode: retrievalMode,
      }),
      retrievalResult.latency.totalMs,
      retrievalResult.totalCandidates,
    ]
  );
  const runId = runRes.rows[0]!.id;

  // 8. Persist retrieval_results for ranked candidates
  for (let i = 0; i < retrievalResult.chunks.length; i++) {
    const chunk = retrievalResult.chunks[i]!;
    await query(
      `INSERT INTO retrieval_results (
         retrieval_run_id, chunk_id, rank, score, retriever_name, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        runId,
        chunk.id,
        chunk.rank,
        chunk.score ?? chunk.similarityScore ?? 0,
        retrievalMode,
        JSON.stringify({
          vectorRank: chunk.vectorRank ?? null,
          lexicalRank: chunk.lexicalRank ?? null,
          rrfScore: chunk.rrfScore ?? null,
        }),
      ]
    );
  }

  // 9. Early abstention if no chunks found
  if (retrievalResult.chunks.length === 0) {
    const abstentionAnswer =
      'I could not find sufficient information in the indexed sources to answer this question.';

    const assistantMsgRes = await query<MessageRow>(
      `INSERT INTO messages (session_id, role, content, retrieval_run_id)
       VALUES ($1, 'assistant', $2, $3)
       RETURNING id, session_id, role, content, retrieval_run_id, created_at`,
      [params.sessionId, abstentionAnswer, runId]
    );
    const assistantMsg = assistantMsgRes.rows[0]!;

    // Link retrieval_run to assistant message
    await query(`UPDATE retrieval_runs SET message_id = $1 WHERE id = $2`, [
      assistantMsg.id,
      runId,
    ]);

    return {
      userMessage: {
        id: userMsg.id,
        sessionId: userMsg.session_id,
        role: userMsg.role,
        content: userMsg.content,
        retrievalRunId: null,
        citations: [],
        createdAt: userMsg.created_at.toISOString(),
      },
      assistantMessage: {
        id: assistantMsg.id,
        sessionId: assistantMsg.session_id,
        role: assistantMsg.role,
        content: assistantMsg.content,
        retrievalRunId: runId,
        citations: [],
        createdAt: assistantMsg.created_at.toISOString(),
      },
      citations: [],
      retrieval: {
        runId,
        retriever: retrievalMode,
        candidateCount: 0,
        topK,
        chunks: [],
      },
      insufficientEvidence: true,
      latency: {
        embeddingMs: retrievalResult.latency.embeddingMs,
        retrievalMs: retrievalResult.latency.retrievalMs,
        generationMs: 0,
        fusionMs: retrievalResult.latency.fusionMs,
        totalMs: retrievalResult.latency.totalMs,
      },
    };
  }

  // 10. Assemble bounded prompt context with citation numbers
  const maxContextChars = params.maxContextChars ?? env.RAG_MAX_CONTEXT_CHARS ?? 12000;
  const { systemPrompt, userPrompt, includedChunks } = buildChatPrompt(
    rewrittenQuery,
    retrievalResult.chunks,
    maxContextChars
  );

  // 11. LLM Generation
  const genStart = Date.now();
  const generationResult = await llmProvider.generate(userPrompt, systemPrompt);
  const generationMs = Math.max(0, Date.now() - genStart);

  // 12. Citation Validation against exact included chunks
  const validation = validateAndSanitizeCitations(generationResult.content, includedChunks);

  // 13. Persist assistant turn
  const assistantMsgRes = await query<MessageRow>(
    `INSERT INTO messages (session_id, role, content, retrieval_run_id)
     VALUES ($1, 'assistant', $2, $3)
     RETURNING id, session_id, role, content, retrieval_run_id, created_at`,
    [params.sessionId, validation.sanitizedAnswer, runId]
  );
  const assistantMsg = assistantMsgRes.rows[0]!;

  // Link retrieval_run to assistant message
  await query(`UPDATE retrieval_runs SET message_id = $1 WHERE id = $2`, [
    assistantMsg.id,
    runId,
  ]);

  // 14. Persist validated citations in citations table
  const persistedCitations: CitationResponse[] = [];
  for (const cite of validation.citations) {
    const citeRes = await query<{ id: string }>(
      `INSERT INTO citations (
         message_id, chunk_id, citation_number, document_id, document_name,
         page_number, section_title, file_path, line_start, line_end, snippet
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        assistantMsg.id,
        cite.chunkId,
        cite.citationNumber,
        cite.documentId,
        cite.documentName,
        cite.pageNumber,
        cite.sectionTitle,
        cite.filePath,
        cite.lineStart,
        cite.lineEnd,
        cite.snippet,
      ]
    );

    persistedCitations.push({
      ...cite,
      id: citeRes.rows[0]?.id,
    });
  }

  const totalMs = retrievalResult.latency.totalMs + generationMs;

  return {
    userMessage: {
      id: userMsg.id,
      sessionId: userMsg.session_id,
      role: userMsg.role,
      content: userMsg.content,
      retrievalRunId: null,
      citations: [],
      createdAt: userMsg.created_at.toISOString(),
    },
    assistantMessage: {
      id: assistantMsg.id,
      sessionId: assistantMsg.session_id,
      role: assistantMsg.role,
      content: assistantMsg.content,
      retrievalRunId: runId,
      citations: persistedCitations,
      createdAt: assistantMsg.created_at.toISOString(),
    },
    citations: persistedCitations,
    retrieval: {
      runId,
      retriever: retrievalMode,
      candidateCount: retrievalResult.totalCandidates,
      topK,
      chunks: includedChunks,
    },
    insufficientEvidence: validation.insufficientEvidence,
    latency: {
      embeddingMs: retrievalResult.latency.embeddingMs,
      retrievalMs: retrievalResult.latency.retrievalMs,
      generationMs,
      fusionMs: retrievalResult.latency.fusionMs,
      totalMs,
    },
  };
}

/**
 * Retrieves full source chunk context for citation viewing in the UI.
 * Strictly verifies tenant boundary and user organization membership.
 */
export async function getChunkSource(
  chunkId: string,
  userId: string
): Promise<ChunkSourceResponse> {
  const res = await query<{
    id: string;
    chunk_index: number;
    content: string;
    character_count: number;
    token_count: number | null;
    page_number: number | null;
    section_title: string | null;
    file_path: string | null;
    line_start: number | null;
    line_end: number | null;
    metadata: Record<string, unknown>;
    created_at: Date;
    document_version_id: string;
    document_id: string;
    document_name: string;
    organization_id: string;
  }>(
    `SELECT
       c.id, c.chunk_index, c.content, c.character_count, c.token_count,
       c.page_number, c.section_title, c.file_path, c.line_start, c.line_end,
       c.metadata, c.created_at,
       dv.id as document_version_id,
       d.id as document_id, d.name as document_name, d.organization_id
     FROM chunks c
     JOIN document_versions dv ON c.document_version_id = dv.id
     JOIN documents d ON dv.document_id = d.id
     WHERE c.id = $1`,
    [chunkId]
  );

  if (res.rows.length === 0) {
    throw new ChatError('Source chunk not found', 'NOT_FOUND', 404);
  }

  const row = res.rows[0]!;

  // Tenant security: verify user membership in chunk's organization
  const member = await getOrganizationMember(row.organization_id, userId);
  if (!member) {
    throw new ChatError('Source chunk not found', 'NOT_FOUND', 404);
  }

  return {
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    documentVersionId: row.document_version_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    characterCount: row.character_count,
    tokenCount: row.token_count,
    pageNumber: row.page_number,
    sectionTitle: row.section_title,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}
