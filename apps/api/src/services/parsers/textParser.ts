import { ParseError, type ParseResult } from './types.js';

/**
 * Parses plain-text engineering documents.
 * Preserves line breaks, calculates character and word counts,
 * and extracts basic line metadata for citation references.
 */
export function parseText(buffer: Buffer): ParseResult {
  const content = buffer.toString('utf-8');
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (normalized.trim().length === 0) {
    throw new ParseError('Text document contains no readable text content.', 'EMPTY_TEXT_CONTENT');
  }

  const words = normalized.trim().split(/\s+/).filter(Boolean);
  const characterCount = normalized.length;
  const wordCount = words.length;

  return {
    sourceType: 'text',
    rawText: normalized,
    characterCount,
    wordCount,
    metadata: {
      lineCount: normalized.split('\n').length,
    },
  };
}
