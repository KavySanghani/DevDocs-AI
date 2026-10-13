import type { DocumentSourceType } from '@devdocs/shared';
import { parseMarkdown } from './markdownParser.js';
import { parsePdf } from './pdfParser.js';
import { parseText } from './textParser.js';
import { ParseError, type ParseResult } from './types.js';

export * from './types.js';
export { parseMarkdown } from './markdownParser.js';
export { parsePdf } from './pdfParser.js';
export { parseText } from './textParser.js';

/**
 * Dispatches parsing to the appropriate format parser based on source type.
 */
export async function parseDocument(
  buffer: Buffer,
  sourceType: DocumentSourceType
): Promise<ParseResult> {
  switch (sourceType) {
    case 'pdf':
      return parsePdf(buffer);
    case 'markdown':
      return parseMarkdown(buffer);
    case 'text':
      return parseText(buffer);
    default:
      throw new ParseError(
        `Unsupported document source type: "${sourceType}". Supported types are pdf, markdown, and text.`,
        'UNSUPPORTED_SOURCE_TYPE',
        400
      );
  }
}
