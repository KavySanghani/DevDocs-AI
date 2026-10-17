import type { LLMProvider } from '../generation/types.js';

export interface QueryRewriteParams {
  currentQuery: string;
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  llmProvider?: LLMProvider | undefined;
}

/**
 * Rewrites follow-up chat questions into standalone technical search queries using
 * a bounded window of recent conversation history.
 *
 * Invariants:
 * 1. Bounded history: Inspects at most the last 4 turns (up to 2 user + 2 assistant messages).
 * 2. Does NOT inject unlimited raw chat history.
 * 3. Never throws; if the provider times out or fails, gracefully falls back to the original query.
 * 4. First turns with empty history return the original query immediately without provider calls.
 */
export async function rewriteQueryForChat(params: QueryRewriteParams): Promise<string> {
  const sanitizedQuery = params.currentQuery.trim();

  // If no previous conversation history, the query is already initial/standalone
  if (!params.history || params.history.length === 0) {
    return sanitizedQuery;
  }

  // Bound history to the last 4 messages (max 2 turns)
  const boundedHistory = params.history.slice(-4);

  // Check if query is short or referential (likely a follow-up)
  const isReferential =
    /\b(it|this|that|these|those|they|them|he|she|here|there|above|previous|also|what about|how about|and where|why)\b/i.test(
      sanitizedQuery
    ) || sanitizedQuery.split(/\s+/).length <= 4;

  if (!isReferential && sanitizedQuery.split(/\s+/).length >= 8) {
    // The query is sufficiently long and self-contained; avoid unnecessary LLM latency
    return sanitizedQuery;
  }

  if (!params.llmProvider) {
    // Without an LLM provider, return the original query
    return sanitizedQuery;
  }

  try {
    const formattedHistory = boundedHistory
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content.slice(0, 300).trim()}`)
      .join('\n');

    const prompt = `CONVERSATION HISTORY:
${formattedHistory}

LATEST QUESTION:
${sanitizedQuery}

INSTRUCTION:
Given the conversation history above and the latest follow-up question, rewrite the latest question into a single, concise, standalone technical search query that incorporates necessary context.
- Return ONLY the standalone search query.
- Do NOT answer the question.
- Do NOT include any prefixes, quotes, explanations, or punctuation other than the query itself.`;

    const result = await params.llmProvider.generate(
      prompt,
      'You are a technical search query rewriter. Return only the rewritten standalone search query.'
    );

    const rewritten = result.content
      .split('\n')[0]
      ?.replace(/^["']|["']$/g, '')
      ?.replace(/^(Standalone Query|Query|Rewritten Query):\s*/i, '')
      ?.trim();

    if (rewritten && rewritten.length > 2 && rewritten.length < 500) {
      return rewritten;
    }

    return sanitizedQuery;
  } catch {
    // Fall back safely to original query on any failure
    return sanitizedQuery;
  }
}
