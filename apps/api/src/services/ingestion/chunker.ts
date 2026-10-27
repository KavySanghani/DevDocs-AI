import type { DocumentSourceType } from '@devdocs/shared';
import type { ChunkInput, ChunkingConfig } from './types.js';

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkSizeChars: 800,
  chunkOverlapChars: 120,
  minChunkSizeChars: 50,
};

/**
 * Estimates token count for English text and code (~4 characters per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface ChunkDocumentParams {
  documentName: string;
  sourceType: DocumentSourceType;
  rawText: string;
  sourceDetails?: Record<string, unknown> | undefined;
  config?:
    | {
        maxChunkSizeChars?: number | undefined;
        chunkOverlapChars?: number | undefined;
        minChunkSizeChars?: number | undefined;
      }
    | undefined;
}

interface ParsedSectionInput {
  title: string;
  level: number;
  content: string;
  lineStart: number;
  lineEnd: number;
}

interface ParsedPageInput {
  pageNumber: number;
  text: string;
}

/**
 * Structure-aware chunking for engineering documentation.
 * Preserves headings, code blocks, page numbers, and line ranges.
 */
export function chunkDocument(params: ChunkDocumentParams): ChunkInput[] {
  const { documentName, sourceType, rawText, sourceDetails, config: userConfig } = params;
  const config: ChunkingConfig = {
    maxChunkSizeChars: userConfig?.maxChunkSizeChars ?? DEFAULT_CHUNKING_CONFIG.maxChunkSizeChars,
    chunkOverlapChars: userConfig?.chunkOverlapChars ?? DEFAULT_CHUNKING_CONFIG.chunkOverlapChars,
    minChunkSizeChars: userConfig?.minChunkSizeChars ?? DEFAULT_CHUNKING_CONFIG.minChunkSizeChars,
  };

  let rawChunks: Omit<ChunkInput, 'chunkIndex'>[] = [];

  switch (sourceType) {
    case 'markdown':
      rawChunks = chunkMarkdown(documentName, rawText, sourceDetails, config);
      break;
    case 'pdf':
      rawChunks = chunkPdf(documentName, rawText, sourceDetails, config);
      break;
    case 'text':
    default:
      rawChunks = chunkPlainText(documentName, rawText, config);
      break;
  }

  // Post-processing: deduplicate adjacent identical chunks and filter out empty ones
  const filteredChunks: Omit<ChunkInput, 'chunkIndex'>[] = [];
  for (const chunk of rawChunks) {
    const trimmed = chunk.content.trim();
    if (trimmed.length === 0) continue;

    // Avoid duplicate adjacent content
    const last = filteredChunks[filteredChunks.length - 1];
    if (last && last.content.trim() === trimmed) {
      continue;
    }

    // Merge tiny chunks into previous if combined length <= maxChunkSizeChars and same section
    if (
      trimmed.length < config.minChunkSizeChars &&
      filteredChunks.length > 0 &&
      last &&
      (!chunk.sectionTitle || chunk.sectionTitle === last.sectionTitle) &&
      last.content.length + trimmed.length + 2 <= config.maxChunkSizeChars
    ) {
      last.content = `${last.content}\n\n${trimmed}`;
      last.characterCount = last.content.length;
      last.tokenCount = estimateTokens(last.content);
      if (chunk.lineEnd && (!last.lineEnd || chunk.lineEnd > last.lineEnd)) {
        last.lineEnd = chunk.lineEnd;
      }
      continue;
    }

    filteredChunks.push({
      ...chunk,
      content: trimmed,
      characterCount: trimmed.length,
      tokenCount: estimateTokens(trimmed),
    });
  }

  // Ensure at least one chunk exists if raw text is non-empty
  if (filteredChunks.length === 0 && rawText.trim().length > 0) {
    const fallbackText = rawText.trim().slice(0, config.maxChunkSizeChars);
    filteredChunks.push({
      content: fallbackText,
      characterCount: fallbackText.length,
      tokenCount: estimateTokens(fallbackText),
      sectionTitle: documentName,
      lineStart: 1,
      lineEnd: fallbackText.split('\n').length,
      metadata: { documentTitle: documentName },
    });
  }

  // Assign deterministic, sequential 0-based chunk indices
  return filteredChunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
  }));
}

/**
 * Splits text into paragraphs and overlapping windows.
 */
function splitTextWithOverlap(
  text: string,
  maxChars: number,
  overlapChars: number
): string[] {
  if (text.length <= maxChars) {
    return [text.trim()];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  let currentBuffer = '';

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if (trimmedPara.length > maxChars) {
      // Flush current buffer first
      if (currentBuffer.trim().length > 0) {
        chunks.push(currentBuffer.trim());
        currentBuffer = '';
      }

      // Split large paragraph by sentence or line
      const sentences = trimmedPara.split(/(?<=[.?!])\s+/);
      let sentenceBuffer = '';

      for (const sentence of sentences) {
        if (sentenceBuffer.length + sentence.length + 1 > maxChars) {
          if (sentenceBuffer.trim().length > 0) {
            chunks.push(sentenceBuffer.trim());
            // Overlap by taking trailing characters of sentenceBuffer
            const overlap = sentenceBuffer.slice(-Math.min(overlapChars, sentenceBuffer.length)).trim();
            sentenceBuffer = overlap ? `${overlap} ${sentence}` : sentence;
          } else {
            // Sentence itself exceeds maxChars; slice it cleanly
            let start = 0;
            while (start < sentence.length) {
              const slice = sentence.slice(start, start + maxChars);
              chunks.push(slice.trim());
              start += maxChars - overlapChars;
            }
            sentenceBuffer = '';
          }
        } else {
          sentenceBuffer = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
        }
      }

      if (sentenceBuffer.trim().length > 0) {
        currentBuffer = sentenceBuffer;
      }
      continue;
    }

    if (currentBuffer.length + trimmedPara.length + 2 > maxChars) {
      if (currentBuffer.trim().length > 0) {
        chunks.push(currentBuffer.trim());
        // Apply overlap from end of previous buffer
        const overlap = currentBuffer.slice(-Math.min(overlapChars, currentBuffer.length)).trim();
        currentBuffer = overlap ? `${overlap}\n\n${trimmedPara}` : trimmedPara;
      } else {
        currentBuffer = trimmedPara;
      }
    } else {
      currentBuffer = currentBuffer ? `${currentBuffer}\n\n${trimmedPara}` : trimmedPara;
    }
  }

  if (currentBuffer.trim().length > 0) {
    chunks.push(currentBuffer.trim());
  }

  return chunks;
}

/**
 * Chunks Markdown while preserving heading hierarchy, line ranges, and code blocks.
 */
function extractMarkdownSections(rawText: string): ParsedSectionInput[] {
  const lines = rawText.split('\n');
  const sections: ParsedSectionInput[] = [];
  let currentSection: ParsedSectionInput | null = null;
  const contentBuffer: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      if (currentSection) {
        currentSection.content = contentBuffer.join('\n');
        currentSection.lineEnd = idx;
        sections.push(currentSection);
        contentBuffer.length = 0;
      }

      currentSection = {
        title: headingMatch[2]!.trim(),
        level: headingMatch[1]!.length,
        content: '',
        lineStart: idx + 1,
        lineEnd: idx + 1,
      };
    } else {
      contentBuffer.push(line);
    }
  }

  if (currentSection) {
    currentSection.content = contentBuffer.join('\n');
    currentSection.lineEnd = lines.length;
    sections.push(currentSection);
  }

  return sections;
}

function chunkMarkdown(
  documentName: string,
  rawText: string,
  sourceDetails: Record<string, unknown> | undefined,
  config: ChunkingConfig
): Omit<ChunkInput, 'chunkIndex'>[] {
  let sections = (sourceDetails?.sections as ParsedSectionInput[]) || [];
  if (sections.length === 0) {
    sections = extractMarkdownSections(rawText);
  }

  if (sections.length > 0) {
    const chunks: Omit<ChunkInput, 'chunkIndex'>[] = [];

    for (const section of sections) {
      const content = section.content.trim();
      if (!content) continue;

      if (content.length <= config.maxChunkSizeChars) {
        chunks.push({
          content,
          characterCount: content.length,
          tokenCount: estimateTokens(content),
          sectionTitle: section.title,
          lineStart: section.lineStart,
          lineEnd: section.lineEnd,
          metadata: {
            sectionLevel: section.level,
            documentTitle: documentName,
          },
        });
      } else {
        // Sub-chunk oversized section
        const subChunks = splitTextWithOverlap(
          content,
          config.maxChunkSizeChars,
          config.chunkOverlapChars
        );
        const totalLines = section.lineEnd - section.lineStart + 1;
        const linesPerChunk = Math.max(1, Math.floor(totalLines / subChunks.length));

        subChunks.forEach((sub, subIdx) => {
          const estimatedLineStart = section.lineStart + subIdx * linesPerChunk;
          const estimatedLineEnd =
            subIdx === subChunks.length - 1
              ? section.lineEnd
              : Math.min(section.lineEnd, estimatedLineStart + linesPerChunk);

          chunks.push({
            content: sub,
            characterCount: sub.length,
            tokenCount: estimateTokens(sub),
            sectionTitle: section.title,
            lineStart: estimatedLineStart,
            lineEnd: estimatedLineEnd,
            metadata: {
              sectionLevel: section.level,
              documentTitle: documentName,
              subChunkIndex: subIdx,
            },
          });
        });
      }
    }

    return chunks;
  }

  // Fallback if sections were not stored: chunk by paragraphs and headings
  return chunkPlainText(documentName, rawText, config);
}

/**
 * Chunks PDF documents while preserving page numbers and page boundaries.
 */
function chunkPdf(
  documentName: string,
  rawText: string,
  sourceDetails: Record<string, unknown> | undefined,
  config: ChunkingConfig
): Omit<ChunkInput, 'chunkIndex'>[] {
  const pages = (sourceDetails?.pages as ParsedPageInput[]) || [];

  if (pages.length > 0) {
    const chunks: Omit<ChunkInput, 'chunkIndex'>[] = [];

    for (const page of pages) {
      const text = page.text.trim();
      if (!text) continue;

      if (text.length <= config.maxChunkSizeChars) {
        chunks.push({
          content: text,
          characterCount: text.length,
          tokenCount: estimateTokens(text),
          pageNumber: page.pageNumber,
          sectionTitle: `Page ${page.pageNumber}`,
          metadata: {
            pageNumber: page.pageNumber,
            documentTitle: documentName,
          },
        });
      } else {
        // Sub-chunk oversized page
        const subChunks = splitTextWithOverlap(
          text,
          config.maxChunkSizeChars,
          config.chunkOverlapChars
        );

        subChunks.forEach((sub, subIdx) => {
          chunks.push({
            content: sub,
            characterCount: sub.length,
            tokenCount: estimateTokens(sub),
            pageNumber: page.pageNumber,
            sectionTitle: `Page ${page.pageNumber} (${subIdx + 1})`,
            metadata: {
              pageNumber: page.pageNumber,
              documentTitle: documentName,
              pagePart: subIdx + 1,
            },
          });
        });
      }
    }

    return chunks;
  }

  return chunkPlainText(documentName, rawText, config);
}

/**
 * Chunks plain text documents using paragraph and sentence boundaries with line tracking.
 */
function chunkPlainText(
  documentName: string,
  rawText: string,
  config: ChunkingConfig
): Omit<ChunkInput, 'chunkIndex'>[] {
  const chunks: Omit<ChunkInput, 'chunkIndex'>[] = [];
  const rawPieces = splitTextWithOverlap(
    rawText,
    config.maxChunkSizeChars,
    config.chunkOverlapChars
  );

  let currentLine = 1;
  for (const piece of rawPieces) {
    const pieceLines = piece.split('\n').length;
    chunks.push({
      content: piece,
      characterCount: piece.length,
      tokenCount: estimateTokens(piece),
      sectionTitle: documentName,
      lineStart: currentLine,
      lineEnd: currentLine + pieceLines - 1,
      metadata: {
        documentTitle: documentName,
      },
    });
    currentLine += Math.max(1, pieceLines - 2); // Approximate step considering overlap
  }

  return chunks;
}
