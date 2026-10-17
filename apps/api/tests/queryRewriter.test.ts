import { describe, it, expect } from 'vitest';
import { rewriteQueryForChat } from '../src/services/chat/queryRewriter.js';
import { MockLLMProvider } from '../src/services/generation/groqProvider.js';

describe('Query Rewriting for Multi-Turn Chat', () => {
  it('returns query unchanged if conversation history is empty', async () => {
    const result = await rewriteQueryForChat({
      currentQuery: 'How is authentication implemented?',
      history: [],
    });

    expect(result).toBe('How is authentication implemented?');
  });

  it('skips rewriting for long, self-contained standalone queries', async () => {
    const history = [
      { role: 'user' as const, content: 'What database do we use?' },
      { role: 'assistant' as const, content: 'We use PostgreSQL with pgvector.' },
    ];

    const standaloneQuery =
      'Explain the exact algorithm used for reciprocal rank fusion in hybrid retrieval.';

    const result = await rewriteQueryForChat({
      currentQuery: standaloneQuery,
      history,
    });

    expect(result).toBe(standaloneQuery);
  });

  it('rewrites short referential queries using bounded history when provider is present', async () => {
    const history = [
      { role: 'user' as const, content: 'Tell me about the JWT authentication token.' },
      {
        role: 'assistant' as const,
        content: 'JWT tokens are signed with HMAC and contain user identity.',
      },
    ];

    const mockLLM = new MockLLMProvider({
      simulatedResponse: 'Where are JWT authentication tokens revoked in the database?',
    });

    const result = await rewriteQueryForChat({
      currentQuery: 'Where is it revoked?',
      history,
      llmProvider: mockLLM,
    });

    expect(result).toBe('Where are JWT authentication tokens revoked in the database?');
  });

  it('gracefully falls back to original query if provider throws an error', async () => {
    const history = [
      { role: 'user' as const, content: 'Tell me about PostgreSQL.' },
      { role: 'assistant' as const, content: 'PostgreSQL is our relational database.' },
    ];

    const failingLLM = new MockLLMProvider({
      simulatedError: 'Connection timeout',
    });

    const result = await rewriteQueryForChat({
      currentQuery: 'What port does it run on?',
      history,
      llmProvider: failingLLM,
    });

    // Must not throw, safely falls back
    expect(result).toBe('What port does it run on?');
  });
});
