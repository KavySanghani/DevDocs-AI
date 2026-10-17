import type { CitationResponse, RetrievedChunk } from '@devdocs/shared';

export interface CitationValidationResult {
  sanitizedAnswer: string;
  citations: CitationResponse[];
  validCitationCount: number;
  invalidCitationCount: number;
  insufficientEvidence: boolean;
}

const ABSTENTION_PATTERNS = [
  'could not find sufficient information',
  'cannot answer this question based on the provided documentation',
  'insufficient evidence',
  'no relevant documentation was found',
  'no relevant documentation found',
  'no information was found',
  'cannot find sufficient information',
  'cannot answer this question based on the indexed',
];

/**
 * Masks fenced code blocks (``` or ~~~) and inline code spans (`...`)
 * with collision-safe tokens so code contents (e.g. `items[0]`, `[99]`)
 * are preserved byte-for-byte and never mistaken for citation markers.
 */
function maskCodeSegments(text: string): {
  maskedText: string;
  codePlaceholders: Map<string, string>;
} {
  const codePlaceholders = new Map<string, string>();
  let placeholderCounter = 0;

  // 1. Mask fenced code blocks (e.g., ```lang ... ``` or ~~~lang ... ~~~)
  const fencedRegex = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  let masked = text.replace(fencedRegex, (match) => {
    const key = `__DEVDOCS_CODE_BLOCK_${placeholderCounter++}__`;
    codePlaceholders.set(key, match);
    return key;
  });

  // 2. Mask inline code spans (e.g. `items[0]` or ``const x = [99];``)
  const inlineRegex = /(`+)([\s\S]*?)\1/g;
  masked = masked.replace(inlineRegex, (match) => {
    const key = `__DEVDOCS_CODE_SPAN_${placeholderCounter++}__`;
    codePlaceholders.set(key, match);
    return key;
  });

  return { maskedText: masked, codePlaceholders };
}

/**
 * Restores masked code blocks and inline code spans verbatim without
 * treating dollar-sign characters ($1, $2, etc.) as replacement patterns.
 */
function restoreCodeSegments(
  text: string,
  codePlaceholders: Map<string, string>
): string {
  let restored = text;
  for (const [key, original] of codePlaceholders.entries()) {
    restored = restored.replaceAll(key, () => original);
  }
  return restored;
}

/**
 * Validates, repairs, and sanitizes generated LLM citations against the exact set
 * of candidate chunks retrieved and included in the bounded prompt context.
 *
 * Security & Reliability Invariants:
 * 1. Citations resolve ONLY to chunks present in the current retrieval context.
 * 2. Fabricated citation numbers (> includedChunks.length or <= 0) in prose are stripped.
 * 3. Code blocks and inline code spans are shielded from citation validation and preserved byte-for-byte.
 * 4. Malformed tags (e.g. "[Source 1]", "[doc: 1]", "[1, 2]") are normalized.
 * 5. If the model explicitly abstains or context is empty, no citations are attached.
 * 6. Factual answers without valid citations return empty citations array (never pretend cited).
 */
export function validateAndSanitizeCitations(
  rawAnswer: string,
  includedChunks: RetrievedChunk[]
): CitationValidationResult {
  const trimmedAnswer = rawAnswer.trim();

  // Protect code blocks and inline code spans before citation validation
  const { maskedText, codePlaceholders } = maskCodeSegments(trimmedAnswer);

  // 1. Explicit abstention check
  const lower = maskedText.toLowerCase();
  const isAbstention = ABSTENTION_PATTERNS.some((pattern) => lower.includes(pattern));

  if (includedChunks.length === 0 || isAbstention) {
    const cleaned =
      includedChunks.length === 0
        ? 'I could not find sufficient information in the indexed sources to answer this question.'
        : maskedText.replace(/\[\s*(?:Source\s*)?\d+\s*\]/gi, '').trim();

    const finalAnswer = restoreCodeSegments(cleaned, codePlaceholders);

    return {
      sanitizedAnswer: finalAnswer,
      citations: [],
      validCitationCount: 0,
      invalidCitationCount: 0,
      insufficientEvidence: true,
    };
  }

  const validChunkCount = includedChunks.length;
  let invalidCitationCount = 0;
  const citedIndices = new Set<number>();

  // 2. Parse and normalize citation tags in text (prose only, code blocks are masked)
  // Handle multi-citation brackets like [1, 2] or [Source 1, Source 2]
  let processedText = maskedText.replace(
    /\[\s*(?:Source\s*)?(\d+)(?:\s*,\s*(?:Source\s*)?(\d+))*\s*\]/gi,
    (match) => {
      // Extract all numbers inside the bracket
      const numbers = (match.match(/\d+/g) || []).map((n) => parseInt(n, 10));
      const validNumbers: number[] = [];

      for (const num of numbers) {
        if (num >= 1 && num <= validChunkCount) {
          validNumbers.push(num);
          citedIndices.add(num);
        } else {
          invalidCitationCount++;
        }
      }

      if (validNumbers.length === 0) {
        return ''; // Remove entirely if all numbers were invalid/fabricated
      }

      // Convert to normalized format e.g. [1][2]
      return validNumbers.map((n) => `[${n}]`).join('');
    }
  );

  // Handle single citation brackets: [1], [Source 1], [doc: 1]
  processedText = processedText.replace(
    /\[\s*(?:Source\s*|doc:\s*)?(\d+)\s*\]/gi,
    (_match, numStr: string) => {
      const num = parseInt(numStr, 10);
      if (num >= 1 && num <= validChunkCount) {
        citedIndices.add(num);
        return `[${num}]`;
      } else {
        invalidCitationCount++;
        return ''; // Safely strip fabricated citation
      }
    }
  );

  // Clean up any double spaces created by stripped citations in prose
  processedText = processedText
    .replace(/[ \t]+/g, ' ')
    .replace(/ \./g, '.')
    .replace(/ ,/g, ',')
    .trim();

  // Restore code blocks and inline code spans verbatim
  processedText = restoreCodeSegments(processedText, codePlaceholders);

  // 3. Assemble validated citation objects in ascending citation number order
  const sortedIndices = Array.from(citedIndices).sort((a, b) => a - b);
  const validatedCitations: CitationResponse[] = [];
  const seenChunkIds = new Set<string>();

  for (const index of sortedIndices) {
    const chunk = includedChunks[index - 1];
    if (!chunk || seenChunkIds.has(chunk.id)) {
      continue;
    }
    seenChunkIds.add(chunk.id);

    validatedCitations.push({
      citationNumber: index,
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      pageNumber: chunk.pageNumber ?? null,
      sectionTitle: chunk.sectionTitle ?? null,
      filePath: chunk.filePath ?? null,
      lineStart: chunk.lineStart ?? null,
      lineEnd: chunk.lineEnd ?? null,
      snippet: chunk.content.slice(0, 300).trim(),
    });
  }

  return {
    sanitizedAnswer: processedText,
    citations: validatedCitations,
    validCitationCount: validatedCitations.length,
    invalidCitationCount,
    insufficientEvidence: false,
  };
}
