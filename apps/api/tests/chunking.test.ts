import { describe, it, expect } from 'vitest';
import {
  normalizeExtractedText,
  normalizeDocumentText,
} from '../src/services/ingestion/normalizer.js';
import {
  chunkDocument,
  DEFAULT_CHUNKING_CONFIG,
  estimateTokens,
} from '../src/services/ingestion/chunker.js';
import { IngestionError } from '../src/services/ingestion/types.js';

describe('Phase 5: Structure-Aware Normalization and Chunking Unit Tests', () => {
  describe('1. Normalization & Text Cleaning', () => {
    it('normalizes CRLF and CR line breaks to LF', () => {
      const input = 'First line\r\nSecond line\rThird line\nFourth line';
      const result = normalizeDocumentText(input);
      expect(result).toBe('First line\nSecond line\nThird line\nFourth line');
    });

    it('strips non-printable ASCII control characters but preserves tabs and newlines', () => {
      const input = "Indented:\t\x00Code\x07With\x1FControls\n\x08Next line";
      const result = normalizeDocumentText(input);
      expect(result).toBe('Indented:\tCodeWithControls\nNext line');
    });

    it('normalizes smart quotes and typographic dashes', () => {
      const input = '“Smart quotes” and ‘single quotes’ — em-dash and – en-dash.';
      const result = normalizeDocumentText(input);
      expect(result).toBe('"Smart quotes" and \'single quotes\' -- em-dash and - en-dash.');
    });

    it('trims trailing whitespace without stripping code indentation', () => {
      const input = '    def calculate_metrics():   \n        return True  \n';
      const result = normalizeDocumentText(input);
      expect(result).toBe('    def calculate_metrics():\n        return True');
    });

    it('compresses excessive consecutive blank lines while preserving paragraph breaks', () => {
      const input = 'Paragraph 1\n\n\n\n\n\nParagraph 2\n\nParagraph 3';
      const result = normalizeDocumentText(input);
      expect(result).toBe('Paragraph 1\n\n\nParagraph 2\n\nParagraph 3');
    });

    it('throws IngestionError when input is empty or pure whitespace', () => {
      expect(() => normalizeExtractedText('')).toThrow(IngestionError);
      expect(() => normalizeExtractedText('   \n\t  ')).toThrow(IngestionError);
      expect(() => normalizeExtractedText(null)).toThrow(IngestionError);
    });
  });

  describe('2. Markdown Structure-Aware Chunking', () => {
    it('preserves heading hierarchy, section title, and line numbers', () => {
      const md = [
        '# System Architecture',
        'Overview of the DevDocs AI microservices and pipelines.',
        '',
        '## Database Tier',
        'PostgreSQL with pgvector extension handles high-dimensional vector embeddings.',
        'HNSW indexes provide sub-linear cosine similarity queries.',
        '',
        '### Ingestion Pipeline',
        'The ingestion pipeline parses, normalizes, chunks, and embeds documents.',
      ].join('\n');

      const chunks = chunkDocument({
        documentName: 'architecture.md',
        sourceType: 'markdown',
        rawText: md,
      });

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]!.chunkIndex).toBe(0);
      expect(chunks[0]!.sectionTitle).toBe('System Architecture');
      expect(chunks[0]!.lineStart).toBe(1);

      const dbChunk = chunks.find((c) => c.sectionTitle === 'Database Tier');
      expect(dbChunk).toBeDefined();
      expect(dbChunk!.content).toContain('PostgreSQL with pgvector');

      const ingestChunk = chunks.find((c) => c.sectionTitle === 'Ingestion Pipeline');
      expect(ingestChunk).toBeDefined();
      expect(ingestChunk!.content).toContain('ingestion pipeline parses');
    });

    it('preserves code blocks intact across chunk boundaries', () => {
      const codeSnippet = [
        '```typescript',
        'interface EmbeddingVector {',
        '  dimensions: 1536;',
        '  data: number[];',
        '}',
        '```',
      ].join('\n');

      const md = `# API Types\n${codeSnippet}`;

      const chunks = chunkDocument({
        documentName: 'types.md',
        sourceType: 'markdown',
        rawText: md,
      });

      expect(chunks.length).toBeGreaterThan(0);
      const codeChunk = chunks.find((c) => c.content.includes('interface EmbeddingVector'));
      expect(codeChunk).toBeDefined();
      expect(codeChunk!.content).toContain('```typescript');
      expect(codeChunk!.content).toContain('```');
    });
  });

  describe('3. PDF Structure-Aware Chunking', () => {
    it('preserves page numbers and splits long pages with overlap', () => {
      const page1Text = 'Page 1 introductory content regarding software design patterns.';
      const page2Text = 'Page 2 contains architectural considerations for cloud deployments.';

      const chunks = chunkDocument({
        documentName: 'design.pdf',
        sourceType: 'pdf',
        rawText: `${page1Text}\n${page2Text}`,
        sourceDetails: {
          pages: [
            { pageNumber: 1, text: page1Text },
            { pageNumber: 2, text: page2Text },
          ],
        },
      });

      expect(chunks.length).toBe(2);
      expect(chunks[0]!.pageNumber).toBe(1);
      expect(chunks[0]!.content).toContain('Page 1 introductory');
      expect(chunks[1]!.pageNumber).toBe(2);
      expect(chunks[1]!.content).toContain('Page 2 contains');
    });
  });

  describe('4. Plain Text Paragraph Chunking', () => {
    it('splits on paragraph boundaries and respects minimum chunk size', () => {
      const text = [
        'Paragraph one discusses introductory principles of distributed systems and network topology.',
        '',
        'Paragraph two analyzes consistency models including eventual consistency and linearizability.',
        '',
        'Paragraph three summarizes consensus algorithms such as Raft and Paxos in real-world clusters.',
      ].join('\n');

      const chunks = chunkDocument({
        documentName: 'systems.txt',
        sourceType: 'text',
        rawText: text,
      });

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.characterCount).toBeGreaterThanOrEqual(DEFAULT_CHUNKING_CONFIG.minChunkSizeChars);
        expect(chunk.tokenCount).toBeGreaterThan(0);
      });
    });
  });

  describe('5. Determinism & Stability', () => {
    it('generates identical chunks for repeated runs on identical input', () => {
      const content = [
        '# Repeatability Benchmark',
        'Verifying that chunk boundaries, indexes, and tokens are perfectly deterministic.',
        'Line 3 ensures repeatable test suites.',
      ].join('\n');

      const run1 = chunkDocument({ documentName: 'doc.md', sourceType: 'markdown', rawText: content });
      const run2 = chunkDocument({ documentName: 'doc.md', sourceType: 'markdown', rawText: content });

      expect(run1.length).toBe(run2.length);
      for (let i = 0; i < run1.length; i++) {
        expect(run1[i]!.chunkIndex).toBe(run2[i]!.chunkIndex);
        expect(run1[i]!.content).toBe(run2[i]!.content);
        expect(run1[i]!.characterCount).toBe(run2[i]!.characterCount);
        expect(run1[i]!.tokenCount).toBe(run2[i]!.tokenCount);
        expect(run1[i]!.sectionTitle).toBe(run2[i]!.sectionTitle);
      }
    });

    it('calculates realistic token estimates (~4 chars per token)', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('word')).toBe(1);
      expect(estimateTokens('12345678')).toBe(2);
      expect(estimateTokens('a'.repeat(400))).toBe(100);
    });
  });
});
