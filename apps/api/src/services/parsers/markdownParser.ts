import { ParseError, type ParseResult, type ParsedSection } from './types.js';

/**
 * Parses Markdown documents while preserving headings, code blocks,
 * and line structures for downstream chunking and citations.
 */
export function parseMarkdown(buffer: Buffer): ParseResult {
  const raw = buffer.toString('utf-8');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (normalized.trim().length === 0) {
    throw new ParseError('Markdown document contains no readable text content.', 'EMPTY_MARKDOWN_CONTENT');
  }

  const lines = normalized.split('\n');
  const sections: ParsedSection[] = [];

  let inCodeBlock = false;
  let currentTitle = 'Overview';
  let currentLevel = 1;
  let currentSectionLines: string[] = [];
  let sectionStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;
    const trimmed = line.trim();

    // Toggle fenced code block state
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      currentSectionLines.push(line);
      continue;
    }

    // Check for markdown headings when NOT inside code blocks
    const headingMatch = !inCodeBlock ? trimmed.match(/^(#{1,6})\s+(.+)$/) : null;

    if (headingMatch) {
      // Finalize the previous section if it has content
      if (currentSectionLines.length > 0 && currentSectionLines.some((l) => l.trim().length > 0)) {
        sections.push({
          title: currentTitle,
          level: currentLevel,
          content: currentSectionLines.join('\n').trim(),
          lineStart: sectionStartLine,
          lineEnd: lineNumber - 1,
        });
      }

      currentLevel = headingMatch[1]!.length;
      currentTitle = headingMatch[2]!.replace(/[*_`]/g, '').trim();
      currentSectionLines = [line];
      sectionStartLine = lineNumber;
    } else {
      currentSectionLines.push(line);
    }
  }

  // Push final section
  if (currentSectionLines.length > 0 && currentSectionLines.some((l) => l.trim().length > 0)) {
    sections.push({
      title: currentTitle,
      level: currentLevel,
      content: currentSectionLines.join('\n').trim(),
      lineStart: sectionStartLine,
      lineEnd: lines.length,
    });
  }

  // Fallback if no sections with content were parsed
  if (sections.length === 0) {
    sections.push({
      title: 'Document Body',
      level: 1,
      content: normalized.trim(),
      lineStart: 1,
      lineEnd: lines.length,
    });
  }

  const words = normalized.trim().split(/\s+/).filter(Boolean);

  return {
    sourceType: 'markdown',
    rawText: normalized,
    characterCount: normalized.length,
    wordCount: words.length,
    sections,
    metadata: {
      sectionCount: sections.length,
      lineCount: lines.length,
    },
  };
}
