import { describe, it, expect } from 'vitest';
import type { RetrievedChunk } from '@devdocs/shared';
import { validateAndSanitizeCitations } from '../src/services/chat/citationValidator.js';

describe('Citation Validation & Sanitization Service', () => {
  const mockChunks: RetrievedChunk[] = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      documentId: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      documentName: 'auth_guide.md',
      documentVersionId: 'ver11111-1111-1111-1111-111111111111',
      chunkIndex: 0,
      content: 'JWT tokens are validated using the HS256 secret in the authentication middleware.',
      characterCount: 82,
      pageNumber: 1,
      sectionTitle: 'JWT Validation',
      filePath: 'src/middleware/auth.ts',
      lineStart: 12,
      lineEnd: 25,
      rank: 1,
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      documentId: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      documentName: 'auth_guide.md',
      documentVersionId: 'ver11111-1111-1111-1111-111111111111',
      chunkIndex: 1,
      content: 'Revoked tokens are stored in the revoked_tokens database table with an expiry date.',
      characterCount: 84,
      pageNumber: 2,
      sectionTitle: 'Token Revocation',
      filePath: 'src/services/authService.ts',
      lineStart: 45,
      lineEnd: 60,
      rank: 2,
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      documentId: 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      documentName: 'architecture.pdf',
      documentVersionId: 'ver22222-2222-2222-2222-222222222222',
      chunkIndex: 0,
      content: 'PostgreSQL provides relational storage with ACID guarantees.',
      characterCount: 60,
      pageNumber: 5,
      sectionTitle: 'Storage Layer',
      rank: 3,
    },
  ];

  it('validates single and multiple valid citations and extracts provenance', () => {
    const rawAnswer =
      'JWT tokens are verified in middleware [1]. Revoked tokens are kept in the database [2].';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.insufficientEvidence).toBe(false);
    expect(result.validCitationCount).toBe(2);
    expect(result.invalidCitationCount).toBe(0);
    expect(result.sanitizedAnswer).toBe(rawAnswer);
    expect(result.citations.length).toBe(2);

    expect(result.citations[0]?.citationNumber).toBe(1);
    expect(result.citations[0]?.chunkId).toBe(mockChunks[0]!.id);
    expect(result.citations[0]?.documentName).toBe('auth_guide.md');
    expect(result.citations[0]?.sectionTitle).toBe('JWT Validation');
    expect(result.citations[0]?.lineStart).toBe(12);

    expect(result.citations[1]?.citationNumber).toBe(2);
    expect(result.citations[1]?.chunkId).toBe(mockChunks[1]!.id);
    expect(result.citations[1]?.sectionTitle).toBe('Token Revocation');
  });

  it('normalizes malformed citation tags like [Source 1], [doc: 2], and [1, 3]', () => {
    const rawAnswer =
      'Authentication is handled per [Source 1], and the storage layer uses PostgreSQL [1, 3].';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.validCitationCount).toBe(2);
    expect(result.sanitizedAnswer).toContain('[1]');
    expect(result.sanitizedAnswer).toContain('[1][3]');
    expect(result.citations.map((c) => c.citationNumber)).toEqual([1, 3]);
  });

  it('safely strips fabricated and out-of-range citation IDs', () => {
    const rawAnswer =
      'JWTs use HMAC [1], but AES is also used for payload encryption [99] and SHA-3 is applied [4].';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.validCitationCount).toBe(1);
    expect(result.invalidCitationCount).toBe(2);
    expect(result.citations.length).toBe(1);
    expect(result.citations[0]?.citationNumber).toBe(1);
    // [99] and [4] should be cleanly stripped from the final text
    expect(result.sanitizedAnswer).not.toContain('[99]');
    expect(result.sanitizedAnswer).not.toContain('[4]');
    expect(result.sanitizedAnswer).toContain('JWTs use HMAC [1]');
  });

  it('abstains immediately when included chunks are empty', () => {
    const result = validateAndSanitizeCitations('Some answer', []);

    expect(result.insufficientEvidence).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.sanitizedAnswer).toBe(
      'I could not find sufficient information in the indexed sources to answer this question.'
    );
  });

  it('abstains and strips citations when the model produces an explicit uncertainty statement', () => {
    const rawAnswer =
      'I could not find sufficient information in the indexed sources to answer this question. [1]';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.insufficientEvidence).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.sanitizedAnswer).not.toContain('[1]');
    expect(result.sanitizedAnswer).toBe(
      'I could not find sufficient information in the indexed sources to answer this question.'
    );
  });

  it('does not pretend un-cited factual answers have citations', () => {
    const rawAnswer =
      'The system is configured with standard microservice parameters and logging thresholds.';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.insufficientEvidence).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.validCitationCount).toBe(0);
    expect(result.sanitizedAnswer).toBe(rawAnswer);
  });

  it('deduplicates multiple references to the same chunk in citations array', () => {
    const rawAnswer = 'First claim [1]. Second claim about same source [1]. Third claim [1].';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.citations.length).toBe(1);
    expect(result.citations[0]?.chunkId).toBe(mockChunks[0]!.id);
  });

  it('preserves bracketed expressions, array indexing, and code byte-for-byte within fenced code blocks', () => {
    const rawAnswer = `To parse items from an array, use:
\`\`\`typescript
const items = [10, 20, 30];
const first = items[0];
const lookup = [99];
\`\`\`
This matches the authentication guidelines [1].`;

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.validCitationCount).toBe(1);
    expect(result.invalidCitationCount).toBe(0);
    expect(result.citations.length).toBe(1);
    expect(result.citations[0]?.citationNumber).toBe(1);

    // Verify fenced code block was preserved byte-for-byte
    expect(result.sanitizedAnswer).toContain('const first = items[0];');
    expect(result.sanitizedAnswer).toContain('const lookup = [99];');
    expect(result.sanitizedAnswer).toContain('```typescript');
    expect(result.sanitizedAnswer).toContain('This matches the authentication guidelines [1].');
  });

  it('preserves array indexing and bracketed expressions within inline code spans', () => {
    const rawAnswer =
      'Call `items[0]` to retrieve the head element or check `matrix[1][2]` and `[99]` inline [2].';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    expect(result.validCitationCount).toBe(1);
    expect(result.invalidCitationCount).toBe(0);
    expect(result.citations.length).toBe(1);
    expect(result.citations[0]?.citationNumber).toBe(2);

    expect(result.sanitizedAnswer).toContain('`items[0]`');
    expect(result.sanitizedAnswer).toContain('`matrix[1][2]`');
    expect(result.sanitizedAnswer).toContain('`[99]`');
    expect(result.sanitizedAnswer).toContain('inline [2].');
  });

  it('strips fabricated citations in prose while preserving identical bracketed expressions in code', () => {
    const rawAnswer =
      'Code sample `const x = [99];` is standard, but the claim in prose is ungrounded [99] and verified [1].';

    const result = validateAndSanitizeCitations(rawAnswer, mockChunks);

    // Only [1] is valid, [99] in prose is invalid
    expect(result.validCitationCount).toBe(1);
    expect(result.invalidCitationCount).toBe(1);
    expect(result.citations.length).toBe(1);
    expect(result.citations[0]?.citationNumber).toBe(1);

    // Inline code preserved
    expect(result.sanitizedAnswer).toContain('`const x = [99];`');
    // Prose [99] stripped
    expect(result.sanitizedAnswer).not.toContain('ungrounded [99]');
    expect(result.sanitizedAnswer).toContain('verified [1].');
  });
});
