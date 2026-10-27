import { query } from '@devdocs/db';
import type {
  DiffChunk,
  DocumentDiffResponse,
  DocumentStatus,
} from '@devdocs/shared';
import { DocError } from './documentService.js';

export interface ComputeTextDiffResult {
  isContentIdentical: boolean;
  linesAdded: number;
  linesRemoved: number;
  linesUnchanged: number;
  unifiedDiff: string;
  chunks: DiffChunk[];
}

/**
 * Computes an LCS-based line-by-line diff and unified diff between two text strings.
 */
export function computeTextDiff(
  textA: string,
  textB: string,
  versionANumber: number = 1,
  versionBNumber: number = 2
): ComputeTextDiffResult {
  const normA = textA.replace(/\r\n/g, '\n');
  const normB = textB.replace(/\r\n/g, '\n');

  if (normA === normB) {
    const lines = normA.length > 0 ? normA.split('\n') : [];
    const chunks: DiffChunk[] = lines.map((line, idx) => ({
      type: 'unchanged',
      text: line,
      lineStart: idx + 1,
      lineEnd: idx + 1,
    }));
    return {
      isContentIdentical: true,
      linesAdded: 0,
      linesRemoved: 0,
      linesUnchanged: lines.length,
      unifiedDiff: '',
      chunks,
    };
  }

  const linesA = normA.length > 0 ? normA.split('\n') : [];
  const linesB = normB.length > 0 ? normB.split('\n') : [];

  const m = linesA.length;
  const n = linesB.length;

  // Guard against massive matrix allocations for exceptionally large files
  const MAX_MATRIX_CELLS = 2_000_000;
  if (m * n > MAX_MATRIX_CELLS) {
    // Truncated/fast fallback for giant inputs
    const chunks: DiffChunk[] = [
      ...linesA.map((line, idx) => ({
        type: 'removed' as const,
        text: line,
        lineStart: idx + 1,
        lineEnd: idx + 1,
      })),
      ...linesB.map((line, idx) => ({
        type: 'added' as const,
        text: line,
        lineStart: idx + 1,
        lineEnd: idx + 1,
      })),
    ];
    return {
      isContentIdentical: false,
      linesAdded: linesB.length,
      linesRemoved: linesA.length,
      linesUnchanged: 0,
      unifiedDiff: `--- v${versionANumber}\n+++ v${versionBNumber}\n@@ -1,${m} +1,${n} @@\n${linesA.map((l) => `-${l}`).join('\n')}\n${linesB.map((l) => `+${l}`).join('\n')}`,
      chunks,
    };
  }

  // Compute Longest Common Subsequence (LCS) table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to build diff chunks
  let i = m;
  let j = n;
  const rawDiff: Array<{ type: 'added' | 'removed' | 'unchanged'; text: string }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      rawDiff.push({ type: 'unchanged', text: linesA[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rawDiff.push({ type: 'added', text: linesB[j - 1]! });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      rawDiff.push({ type: 'removed', text: linesA[i - 1]! });
      i--;
    }
  }

  rawDiff.reverse();

  let linesAdded = 0;
  let linesRemoved = 0;
  let linesUnchanged = 0;
  let lineNum = 1;

  const chunks: DiffChunk[] = [];
  const unifiedLines: string[] = [];

  for (const item of rawDiff) {
    if (item.type === 'added') {
      linesAdded++;
      chunks.push({
        type: 'added',
        text: item.text,
        lineStart: lineNum,
        lineEnd: lineNum,
      });
      unifiedLines.push(`+${item.text}`);
      lineNum++;
    } else if (item.type === 'removed') {
      linesRemoved++;
      chunks.push({
        type: 'removed',
        text: item.text,
        lineStart: lineNum,
        lineEnd: lineNum,
      });
      unifiedLines.push(`-${item.text}`);
    } else {
      linesUnchanged++;
      chunks.push({
        type: 'unchanged',
        text: item.text,
        lineStart: lineNum,
        lineEnd: lineNum,
      });
      unifiedLines.push(` ${item.text}`);
      lineNum++;
    }
  }

  const header = `--- v${versionANumber}\n+++ v${versionBNumber}\n@@ -1,${m} +1,${n} @@\n`;
  const unifiedDiff = header + unifiedLines.join('\n');

  return {
    isContentIdentical: linesAdded === 0 && linesRemoved === 0,
    linesAdded,
    linesRemoved,
    linesUnchanged,
    unifiedDiff,
    chunks,
  };
}

interface VersionQueryRow {
  id: string;
  document_id: string;
  document_name: string;
  version_number: number;
  content_hash: string;
  status: DocumentStatus;
  source_details: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Compares two versions of a document within an authorized organization workspace.
 */
export async function compareDocumentVersions(params: {
  documentId: string;
  fromVersion?: string | number | undefined;
  toVersion?: string | number | undefined;
  organizationId: string;
}): Promise<DocumentDiffResponse> {
  const { documentId, organizationId } = params;

  // Fetch all versions for this document within the organization
  const versionsRes = await query<VersionQueryRow>(
    `SELECT dv.id, dv.document_id, d.name AS document_name, dv.version_number,
            dv.content_hash, dv.status, dv.source_details, dv.created_at, dv.updated_at
     FROM document_versions dv
     JOIN documents d ON d.id = dv.document_id
     WHERE d.id = $1 AND d.organization_id = $2
     ORDER BY dv.version_number ASC`,
    [documentId, organizationId]
  );

  if (versionsRes.rows.length === 0) {
    throw new DocError('Document not found or access denied', 404, 'DOCUMENT_NOT_FOUND');
  }

  const allVersions = versionsRes.rows;
  const documentName = allVersions[0]!.document_name;

  let fromRow: VersionQueryRow | undefined;
  let toRow: VersionQueryRow | undefined;

  // Resolve fromVersion
  if (params.fromVersion !== undefined && params.fromVersion !== null && params.fromVersion !== '') {
    const fromStr = String(params.fromVersion).trim();
    fromRow = allVersions.find(
      (v) => v.id === fromStr || String(v.version_number) === fromStr
    );
  } else {
    // Default fromVersion is the second-to-latest version (or earliest version if only 1 exists)
    fromRow = allVersions.length > 1 ? allVersions[allVersions.length - 2] : allVersions[0];
  }

  // Resolve toVersion
  if (params.toVersion !== undefined && params.toVersion !== null && params.toVersion !== '') {
    const toStr = String(params.toVersion).trim();
    toRow = allVersions.find(
      (v) => v.id === toStr || String(v.version_number) === toStr
    );
  } else {
    // Default toVersion is the latest version
    toRow = allVersions[allVersions.length - 1];
  }

  if (!fromRow) {
    throw new DocError(
      `Version "${params.fromVersion}" not found for this document`,
      404,
      'VERSION_NOT_FOUND'
    );
  }

  if (!toRow) {
    throw new DocError(
      `Version "${params.toVersion}" not found for this document`,
      404,
      'VERSION_NOT_FOUND'
    );
  }

  const fromDetails = (fromRow.source_details as Record<string, unknown>) ?? {};
  const toDetails = (toRow.source_details as Record<string, unknown>) ?? {};

  const fromRawText = typeof fromDetails.rawText === 'string' ? fromDetails.rawText : '';
  const toRawText = typeof toDetails.rawText === 'string' ? toDetails.rawText : '';

  const fromCharCount =
    typeof fromDetails.characterCount === 'number'
      ? fromDetails.characterCount
      : fromRawText.length;
  const toCharCount =
    typeof toDetails.characterCount === 'number'
      ? toDetails.characterCount
      : toRawText.length;
  const characterCountDelta = toCharCount - fromCharCount;

  const fromChunkCount =
    typeof fromDetails.chunkCount === 'number' ? fromDetails.chunkCount : 0;
  const toChunkCount =
    typeof toDetails.chunkCount === 'number' ? toDetails.chunkCount : 0;
  const chunkCountDelta = toChunkCount - fromChunkCount;

  // Compute text diff
  const textDiff = computeTextDiff(
    fromRawText,
    toRawText,
    fromRow.version_number,
    toRow.version_number
  );

  // Compare sections if present
  let sectionsDiff: { added: string[]; removed: string[]; unchanged: string[] } | undefined;
  const fromSections = Array.isArray(fromDetails.sections)
    ? (fromDetails.sections as Array<{ title?: string }>).map((s) => s.title ?? '').filter(Boolean)
    : [];
  const toSections = Array.isArray(toDetails.sections)
    ? (toDetails.sections as Array<{ title?: string }>).map((s) => s.title ?? '').filter(Boolean)
    : [];

  if (fromSections.length > 0 || toSections.length > 0) {
    const fromSet = new Set(fromSections);
    const toSet = new Set(toSections);

    const added = toSections.filter((s) => !fromSet.has(s));
    const removed = fromSections.filter((s) => !toSet.has(s));
    const unchanged = toSections.filter((s) => fromSet.has(s));

    sectionsDiff = { added, removed, unchanged };
  }

  const isContentIdentical =
    fromRow.content_hash === toRow.content_hash || textDiff.isContentIdentical;

  return {
    documentId,
    documentName,
    fromVersion: {
      id: fromRow.id,
      versionNumber: fromRow.version_number,
      contentHash: fromRow.content_hash,
      status: fromRow.status,
      createdAt: fromRow.created_at.toISOString(),
    },
    toVersion: {
      id: toRow.id,
      versionNumber: toRow.version_number,
      contentHash: toRow.content_hash,
      status: toRow.status,
      createdAt: toRow.created_at.toISOString(),
    },
    isContentIdentical,
    characterCountDelta,
    chunkCountDelta,
    linesAdded: textDiff.linesAdded,
    linesRemoved: textDiff.linesRemoved,
    linesUnchanged: textDiff.linesUnchanged,
    unifiedDiff: textDiff.unifiedDiff,
    chunks: textDiff.chunks,
    ...(sectionsDiff ? { sections: sectionsDiff } : {}),
  };
}
