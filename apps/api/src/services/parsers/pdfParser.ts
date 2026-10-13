import { extractText } from 'unpdf';
import { ParseError, type ParseResult, type ParsedPage } from './types.js';

/**
 * Parses PDF documents page-by-page using unpdf.
 * Preserves page numbers for citation reference and identifies
 * image-only/scanned PDFs that lack text streams.
 */
export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  // Validate standard PDF magic bytes (%PDF-)
  if (buffer.length < 5 || buffer.toString('utf-8', 0, 5) !== '%PDF-') {
    throw new ParseError('Invalid PDF file signature. Expected %PDF- header.', 'INVALID_PDF_SIGNATURE', 400);
  }

  let extracted: { totalPages: number; text: string[] };
  try {
    const uint8Array = new Uint8Array(buffer);
    extracted = await extractText(uint8Array, { mergePages: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown parsing error';
    throw new ParseError(`Malformed or corrupted PDF file could not be parsed: ${message}`, 'MALFORMED_PDF', 422);
  }

  const { totalPages, text } = extracted;
  const pages: ParsedPage[] = [];
  let combinedText = '';

  for (let i = 0; i < (text?.length ?? 0); i++) {
    const pageText = text[i]?.trim() ?? '';
    pages.push({
      pageNumber: i + 1,
      text: pageText,
      characterCount: pageText.length,
    });
    if (pageText.length > 0) {
      combinedText += (combinedText.length > 0 ? '\n\n' : '') + pageText;
    }
  }

  // Scanned or image-only PDFs yield 0 extractable characters
  if (combinedText.trim().length === 0) {
    throw new ParseError(
      'PDF contains no extractable text. Scanned or image-only documents require OCR, which is not currently supported.',
      'EMPTY_PDF_TEXT',
      422
    );
  }

  const words = combinedText.trim().split(/\s+/).filter(Boolean);

  return {
    sourceType: 'pdf',
    rawText: combinedText,
    characterCount: combinedText.length,
    wordCount: words.length,
    pageCount: totalPages,
    pages,
    metadata: {
      totalPages,
      pageCount: totalPages,
    },
  };
}
