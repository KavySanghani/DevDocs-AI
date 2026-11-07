import type { ChunkInput } from '../ingestion/types.js';
import { estimateTokens, DEFAULT_CHUNKING_CONFIG } from '../ingestion/chunker.js';
import { detectLanguage } from './githubPolicy.js';

export interface ChunkCodeParams {
  filePath: string;
  content: string;
  repoOwner: string;
  repoName: string;
  repoRef: string;
  commitSha: string;
  config?:
    | {
        maxChunkSizeChars?: number | undefined;
        chunkOverlapChars?: number | undefined;
        minChunkSizeChars?: number | undefined;
      }
    | undefined;
}

/**
 * Deterministic line-based chunker for source code files.
 * Preserves exact file paths, 1-based start and end line ranges, detected language,
 * and repository provenance. Prefers splitting on logical boundaries (blank lines, closing braces).
 */
export function chunkCodeFile(params: ChunkCodeParams): Omit<ChunkInput, 'chunkIndex'>[] {
  const { filePath, content, repoOwner, repoName, repoRef, commitSha, config: userConfig } = params;

  if (!content || content.trim().length === 0) {
    return [];
  }

  const maxChars = userConfig?.maxChunkSizeChars ?? DEFAULT_CHUNKING_CONFIG.maxChunkSizeChars; // 800
  const overlapChars = userConfig?.chunkOverlapChars ?? DEFAULT_CHUNKING_CONFIG.chunkOverlapChars; // 120
  const minChars = userConfig?.minChunkSizeChars ?? DEFAULT_CHUNKING_CONFIG.minChunkSizeChars; // 50

  const language = detectLanguage(filePath);
  const lines = content.split('\n');
  const chunks: Omit<ChunkInput, 'chunkIndex'>[] = [];

  let chunkStartLine = 1; // 1-indexed
  let currentLines: string[] = [];
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineWithNewline = i < lines.length - 1 ? `${line}\n` : line;

    // Check if adding this line exceeds target size and we have at least some lines accumulated
    if (currentChars + lineWithNewline.length > maxChars && currentLines.length > 0) {
      // Look back a few lines for a clean boundary (e.g. blank line or closing brace)
      let splitIdx = currentLines.length;
      for (let j = currentLines.length - 1; j >= Math.max(1, currentLines.length - 10); j--) {
        const candidate = currentLines[j]?.trim();
        if (candidate === '' || candidate === '}' || candidate === '};' || candidate === '})' || candidate === '])') {
          splitIdx = j + 1;
          break;
        }
      }

      // Slice the lines that form the current chunk
      const chunkSlice = currentLines.slice(0, splitIdx);
      const chunkContent = chunkSlice.join('');
      const chunkEndLine = chunkStartLine + chunkSlice.length - 1;

      if (chunkContent.trim().length >= minChars || chunks.length === 0) {
        chunks.push({
          content: chunkContent.trimEnd(),
          characterCount: chunkContent.length,
          tokenCount: estimateTokens(chunkContent),
          filePath,
          lineStart: chunkStartLine,
          lineEnd: chunkEndLine,
          sectionTitle: `${filePath}:${chunkStartLine}-${chunkEndLine}`,
          metadata: {
            sourceType: 'code',
            repoOwner,
            repoName,
            repoRef,
            commitSha,
            language,
            filePath,
            lineStart: chunkStartLine,
            lineEnd: chunkEndLine,
          },
        });
      }

      // Compute overlap lines for next chunk
      const remainderLines = currentLines.slice(splitIdx);
      let overlapLines: string[] = [];
      let overlapAccumulated = 0;

      // Take lines backwards from the end of the chunk up to overlapChars
      for (let k = chunkSlice.length - 1; k >= 0; k--) {
        const oLine = chunkSlice[k]!;
        overlapAccumulated += oLine.length;
        overlapLines.unshift(oLine);
        if (overlapAccumulated >= overlapChars || overlapLines.length >= 15) {
          break;
        }
      }

      currentLines = [...overlapLines, ...remainderLines];
      currentChars = currentLines.reduce((acc, l) => acc + l.length, 0);
      chunkStartLine = chunkEndLine - overlapLines.length + 1;
    }

    currentLines.push(lineWithNewline);
    currentChars += lineWithNewline.length;
  }

  // Final remaining lines
  if (currentLines.length > 0) {
    const chunkContent = currentLines.join('');
    const chunkEndLine = chunkStartLine + currentLines.length - 1;

    if (chunkContent.trim().length > 0) {
      chunks.push({
        content: chunkContent.trimEnd(),
        characterCount: chunkContent.length,
        tokenCount: estimateTokens(chunkContent),
        filePath,
        lineStart: chunkStartLine,
        lineEnd: chunkEndLine,
        sectionTitle: `${filePath}:${chunkStartLine}-${chunkEndLine}`,
        metadata: {
          sourceType: 'code',
          repoOwner,
          repoName,
          repoRef,
          commitSha,
          language,
          filePath,
          lineStart: chunkStartLine,
          lineEnd: chunkEndLine,
        },
      });
    }
  }

  return chunks;
}
