import { IngestionError } from './types.js';

export interface NormalizedDocument {
  text: string;
  characterCount: number;
  lineCount: number;
}

/**
 * Validates and normalizes document text, preserving structure,
 * paragraph separations, and indentation for technical documentation and code.
 */
export function normalizeExtractedText(rawText: unknown): NormalizedDocument {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw new IngestionError(
      'Document contains no valid extracted text to ingest.',
      'normalization',
      422
    );
  }

  // 1. Normalize line endings to standard LF
  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. Strip dangerous/unprintable ASCII control characters
  // Preserves \t (0x09) and \n (0x0A)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 3. Normalize non-standard Unicode typographical characters
  text = text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--');

  // 4. Clean trailing whitespace per line without destroying leading indentation
  const lines = text.split('\n');
  const cleanedLines = lines.map((l) => l.trimEnd());
  text = cleanedLines.join('\n');

  // 5. Compress excessive blank lines (more than 3 consecutive newlines to 2)
  text = text.replace(/\n{4,}/g, '\n\n\n').replace(/^\n+|\n+$/g, '');

  if (text.length === 0) {
    throw new IngestionError(
      'Document text is empty after cleaning and normalization.',
      'normalization',
      422
    );
  }

  return {
    text,
    characterCount: text.length,
    lineCount: text.split('\n').length,
  };
}

/**
 * Convenience helper returning just the normalized text string.
 */
export function normalizeDocumentText(rawText: unknown): string {
  return normalizeExtractedText(rawText).text;
}
