import { query, withTransaction } from '@devdocs/db';
import {
  type DocumentStatus,
  type GitHubImportResponse,
  type GitHubRepoItem,
  type GitHubSourceViewerResponse,
  hasMinimumRole,
} from '@devdocs/shared';
import { getEnv } from '../../config/env.js';
import { DocError } from '../documentService.js';
import { getOrganizationMember } from '../organizationService.js';
import { createJob, updateJobStatus, type JobFencingContext } from '../jobs/jobService.js';
import { enqueueIngestionJob, type IngestionJobData } from '../queue/ingestionQueue.js';
import { createEmbeddingProvider } from '../ingestion/index.js';
import { persistChunksWithEmbeddings } from '../ingestion/chunkPersistence.js';
import type { ChunkWithEmbedding, EmbeddingProvider } from '../ingestion/types.js';
import { validateAndNormalizeGitHubUrl } from './githubUrlValidator.js';
import {
  isFileEligible,
  isContentSafe,
  detectLanguage,
  DEFAULT_GITHUB_LIMITS,
  type GitHubResourceLimits,
} from './githubPolicy.js';
import {
  GitHubClient,
  GitHubClientError,
  GitHubRateLimitError,
  type GitHubTreeItem,
} from './githubClient.js';
import { chunkCodeFile } from './codeChunker.js';

export interface StartRepoImportParams {
  organizationId: string;
  userId: string;
  repoUrl: string;
  ref?: string | undefined;
  name?: string | undefined;
  client?: GitHubClient | undefined;
}

export interface ProcessRepoImportOptions {
  client?: GitHubClient | undefined;
  overrideProvider?: EmbeddingProvider | undefined;
  fencingContext?: JobFencingContext | undefined;
  limits?: GitHubResourceLimits | undefined;
}

/**
 * Initiates the asynchronous import of a public GitHub repository.
 * Validates URLs, verifies Member+ RBAC, ensures idempotency, and enqueues a background job.
 */
export async function startRepoImport(
  params: StartRepoImportParams
): Promise<GitHubImportResponse> {
  const { organizationId, userId, repoUrl, ref, name, client: customClient } = params;

  // 1. Enforce RBAC: Member+ role required to import repositories
  const member = await getOrganizationMember(organizationId, userId);
  if (!member) {
    throw new DocError('Organization membership required.', 404, 'ORGANIZATION_NOT_FOUND');
  }

  if (!hasMinimumRole(member.role, 'member')) {
    throw new DocError(
      'Only Organization Members or Admins are permitted to import GitHub repositories.',
      403,
      'FORBIDDEN'
    );
  }

  // 2. Validate and normalize the repository URL
  const validatedUrl = validateAndNormalizeGitHubUrl(repoUrl);
  const targetRef = ref && ref.trim() !== '' ? ref.trim() : validatedUrl.ref;

  // 3. Resolve commit SHA via GitHub Client
  const client = customClient ?? new GitHubClient();
  const repoMeta = await client.getRepository(validatedUrl.owner, validatedUrl.repo);
  const resolved = await client.resolveCommitSha(
    validatedUrl.owner,
    validatedUrl.repo,
    targetRef || repoMeta.defaultBranch
  );

  const documentName = name && name.trim() !== ''
    ? name.trim()
    : `${validatedUrl.owner}/${validatedUrl.repo}`;

  // 4. Atomically find or create the parent logical document (source_type = 'github')
  const { doc, version, isNewVersion } = await withTransaction(async (txClient) => {
    // Check if document already exists for this repo in this organization
    const existingDocRes = await txClient.query<{ id: string; name: string; current_version_id: string | null }>(
      `SELECT id, name, current_version_id
       FROM documents
       WHERE organization_id = $1 AND source_type = 'github' AND name = $2
       FOR UPDATE`,
      [organizationId, documentName]
    );

    let docId: string;
    let docRecord = existingDocRes.rows[0];

    if (!docRecord) {
      const newDocRes = await txClient.query<{ id: string; name: string; current_version_id: string | null }>(
        `INSERT INTO documents (organization_id, created_by, name, source_type)
         VALUES ($1, $2, $3, 'github')
         RETURNING id, name, current_version_id`,
        [organizationId, userId, documentName]
      );
      docRecord = newDocRes.rows[0]!;
      docId = docRecord.id;
    } else {
      docId = docRecord.id;
    }

    // 5. Idempotency Check: check if a version for this exact commit SHA already exists
    const existingVerRes = await txClient.query<{
      id: string;
      version_number: number;
      status: DocumentStatus;
      content_hash: string;
    }>(
      `SELECT id, version_number, status, content_hash
       FROM document_versions
       WHERE document_id = $1 AND content_hash = $2
       ORDER BY version_number DESC
       LIMIT 1`,
      [docId, resolved.commitSha]
    );

    const existingVer = existingVerRes.rows[0];
    if (existingVer && existingVer.status === 'ready') {
      return { doc: docRecord, version: existingVer, isNewVersion: false };
    }

    // If version exists but is queued or processing, return existing
    if (existingVer && (existingVer.status === 'queued' || existingVer.status === 'processing')) {
      return { doc: docRecord, version: existingVer, isNewVersion: false };
    }

    // Create a new version for this commit
    const maxVerRes = await txClient.query<{ max_version: number | null }>(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS max_version FROM document_versions WHERE document_id = $1',
      [docId]
    );
    const nextVer = maxVerRes.rows[0]?.max_version ?? 1;

    const sourceDetails = {
      repoUrl: validatedUrl.canonicalUrl,
      owner: validatedUrl.owner,
      repo: validatedUrl.repo,
      ref: resolved.ref,
      commitSha: resolved.commitSha,
      defaultBranch: repoMeta.defaultBranch,
      description: repoMeta.description,
      importedAt: new Date().toISOString(),
    };

    const newVerRes = await txClient.query<{
      id: string;
      version_number: number;
      status: DocumentStatus;
      content_hash: string;
    }>(
      `INSERT INTO document_versions (document_id, version_number, content_hash, status, source_details)
       VALUES ($1, $2, $3, 'queued', $4)
       RETURNING id, version_number, status, content_hash`,
      [docId, nextVer, resolved.commitSha, JSON.stringify(sourceDetails)]
    );

    return { doc: docRecord, version: newVerRes.rows[0]!, isNewVersion: true };
  });

  // 6. Create durable background job with scoped idempotency key
  const idempotencyKey = `repo_import:${doc.id}:${version.id}:${resolved.commitSha}`;

  const { job, isNew } = await createJob({
    organizationId,
    type: 'repo_import',
    idempotencyKey,
    payload: {
      documentId: doc.id,
      versionId: version.id,
      organizationId,
      repoUrl: validatedUrl.canonicalUrl,
      owner: validatedUrl.owner,
      repo: validatedUrl.repo,
      ref: resolved.ref,
      commitSha: resolved.commitSha,
      stage: isNewVersion ? 'queued' : 'completed',
    },
  });

  if (isNewVersion && isNew) {
    // 7. Enqueue to BullMQ worker queue
    await enqueueIngestionJob({
      jobId: job.id,
      organizationId,
      documentId: doc.id,
      versionId: version.id,
      type: 'repo_import',
    });
  }

  return {
    jobId: job.id,
    status: (job.status as any) || 'queued',
    documentId: doc.id,
    versionId: version.id,
    isExisting: !isNewVersion,
    repository: {
      owner: validatedUrl.owner,
      repo: validatedUrl.repo,
      ref: resolved.ref,
      commitSha: resolved.commitSha,
    },
    message: isNewVersion
      ? 'GitHub repository import job enqueued successfully.'
      : 'Repository already imported at this commit.',
  };
}

/**
 * Worker processor for GitHub repository import jobs.
 * Enforces resource caps, ignore policy, line-based chunking, embeddings, and atomic chunk persistence.
 */
export async function processRepoImportJob(
  data: IngestionJobData,
  options?: ProcessRepoImportOptions
): Promise<{ success: boolean; chunkCount: number; versionId: string }> {
  const { jobId, documentId, versionId, organizationId } = data;
  const limits = options?.limits ?? DEFAULT_GITHUB_LIMITS;
  const client = options?.client ?? new GitHubClient();
  const provider = options?.overrideProvider ?? createEmbeddingProvider(getEnv());

  // 1. Fetch version details
  const verRes = await query<{
    id: string;
    document_id: string;
    version_number: number;
    content_hash: string;
    status: DocumentStatus;
    source_details: Record<string, unknown>;
  }>(
    'SELECT id, document_id, version_number, content_hash, status, source_details FROM document_versions WHERE id = $1',
    [versionId]
  );
  const versionRow = verRes.rows[0];
  if (!versionRow) {
    throw new DocError(`Document version ${versionId} not found.`, 404, 'VERSION_NOT_FOUND');
  }

  const sourceDetails = versionRow.source_details || {};
  const owner = String(sourceDetails.owner || '');
  const repo = String(sourceDetails.repo || '');
  const ref = String(sourceDetails.ref || 'main');
  const commitSha = String(versionRow.content_hash || sourceDetails.commitSha || '');

  if (!owner || !repo || !commitSha) {
    throw new DocError('Missing repository metadata in document version.', 400, 'INVALID_VERSION_METADATA');
  }

  // 2. Discover tree items
  await updateJobStatus(jobId, { stage: 'discovering' });
  const treeItems = await client.getGitTree(owner, repo, commitSha);

  // 3. Filter files according to ignore and safety policy
  let filesDiscovered = treeItems.length;
  let eligibleItems: GitHubTreeItem[] = [];
  let filesExcluded = 0;
  let totalBytes = 0;

  for (const item of treeItems) {
    const check = isFileEligible(item.path, item.size, limits, item.mode);
    if (check.eligible) {
      eligibleItems.push(item);
      totalBytes += item.size ?? 0;
    } else {
      filesExcluded++;
    }
  }

  // Enforce repository file count limit
  if (eligibleItems.length > limits.maxFiles) {
    filesExcluded += eligibleItems.length - limits.maxFiles;
    eligibleItems = eligibleItems.slice(0, limits.maxFiles);
  }

  // Enforce repository size limit
  if (totalBytes > limits.maxRepoBytes) {
    throw new DocError(
      `Repository eligible content size (${totalBytes} bytes) exceeds limit (${limits.maxRepoBytes} bytes).`,
      400,
      'REPO_TOO_LARGE'
    );
  }

  // 4. Download eligible files and check content safety
  await updateJobStatus(jobId, { stage: 'downloading' });
  const downloadedFiles: Array<{ path: string; content: string; size: number }> = [];

  for (const item of eligibleItems) {
    try {
      const content = await client.getBlobContent(owner, repo, item.sha);
      const safeCheck = isContentSafe(content);
      if (!safeCheck.safe) {
        filesExcluded++;
        continue;
      }
      downloadedFiles.push({ path: item.path, content, size: item.size ?? content.length });
    } catch (err: unknown) {
      if (err instanceof GitHubRateLimitError) {
        throw err;
      }
      if (err instanceof GitHubClientError) {
        if (err.isTransient) {
          throw err;
        }
        // Only 404 (e.g. missing/corrupt blob resource) is considered a file-level non-retryable exclusion
        if (err.code === 'RESOURCE_NOT_FOUND' || err.statusCode === 404) {
          filesExcluded++;
          continue;
        }
        // Other non-transient client errors (e.g. 401/403 access denied, disallowed target) are repository-wide failures
        throw err;
      }
      // Unknown or fatal errors must not be silently swallowed
      throw err;
    }
  }

  // 5. Chunk source code files
  await updateJobStatus(jobId, { stage: 'chunking' });
  const allChunks: ChunkWithEmbedding[] = [];

  for (const file of downloadedFiles) {
    const fileChunks = chunkCodeFile({
      filePath: file.path,
      content: file.content,
      repoOwner: owner,
      repoName: repo,
      repoRef: ref,
      commitSha,
      config: data.config,
    });

    for (let c = 0; c < fileChunks.length; c++) {
      allChunks.push({
        ...fileChunks[c]!,
        chunkIndex: allChunks.length,
        embedding: [], // To be populated
      });
    }
  }

  // 6. Generate embeddings for code chunks in batches
  await updateJobStatus(jobId, { stage: 'embedding' });
  const BATCH_SIZE = 100;
  for (let b = 0; b < allChunks.length; b += BATCH_SIZE) {
    const slice = allChunks.slice(b, b + BATCH_SIZE);
    const texts = slice.map((c) => c.content);
    const embeddings = await provider.embedChunks(texts);
    for (let i = 0; i < slice.length; i++) {
      slice[i]!.embedding = embeddings[i]!;
    }
  }

  // 7. Atomically persist chunks and finalize under distributed fencing lock
  await updateJobStatus(jobId, { stage: 'persisting' });

  const finalSourceDetails = {
    ...sourceDetails,
    filesDiscovered,
    filesEligible: eligibleItems.length,
    filesExcluded,
    filesProcessed: downloadedFiles.length,
    chunkCount: allChunks.length,
    totalBytes,
    completedAt: new Date().toISOString(),
  };

  await persistChunksWithEmbeddings({
    documentVersionId: versionId,
    organizationId,
    documentId,
    chunks: allChunks,
    fencingContext: options?.fencingContext,
    versionFinalization: {
      sourceDetails: finalSourceDetails,
    },
    jobFinalization: {
      payloadUpdates: {
        stage: 'completed',
        chunkCount: allChunks.length,
        fileCount: downloadedFiles.length,
        totalBytes,
      },
    },
  });

  if (!options?.fencingContext) {
    await updateJobStatus(jobId, {
      status: 'ready',
      stage: 'completed',
      payloadUpdates: {
        ...finalSourceDetails,
        stage: 'completed',
      },
    });
  }

  return {
    success: true,
    chunkCount: allChunks.length,
    versionId,
  };
}

/**
 * Lists all imported GitHub repositories in an organization.
 */
export async function listRepositories(
  organizationId: string,
  callerUserId: string
): Promise<GitHubRepoItem[]> {
  const member = await getOrganizationMember(organizationId, callerUserId);
  if (!member) {
    throw new DocError('Organization membership required.', 404, 'ORGANIZATION_NOT_FOUND');
  }

  const res = await query<{
    id: string;
    organization_id: string;
    name: string;
    source_type: 'github';
    current_version_id: string | null;
    created_at: Date;
    updated_at: Date;
    version_number?: number;
    commit_sha?: string;
    status?: DocumentStatus;
    source_details?: Record<string, unknown>;
  }>(
    `SELECT d.id, d.organization_id, d.name, d.source_type, d.current_version_id,
            d.created_at, d.updated_at,
            dv.version_number, dv.content_hash AS commit_sha, dv.status, dv.source_details
     FROM documents d
     LEFT JOIN document_versions dv ON dv.id = d.current_version_id
     WHERE d.organization_id = $1 AND d.source_type = 'github'
     ORDER BY d.updated_at DESC`,
    [organizationId]
  );

  return res.rows.map((row) => {
    const details = row.source_details || {};
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      sourceType: 'github',
      currentVersionId: row.current_version_id,
      versionNumber: row.version_number,
      commitSha: row.commit_sha,
      status: row.status,
      repoOwner: typeof details.owner === 'string' ? details.owner : undefined,
      repoName: typeof details.repo === 'string' ? details.repo : undefined,
      repoRef: typeof details.ref === 'string' ? details.ref : undefined,
      fileCount: typeof details.filesProcessed === 'number' ? details.filesProcessed : undefined,
      chunkCount: typeof details.chunkCount === 'number' ? details.chunkCount : undefined,
      totalBytes: typeof details.totalBytes === 'number' ? details.totalBytes : undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

/**
 * Retrieves repository details, including latest version and commit metadata.
 */
export async function getRepositoryById(
  documentId: string,
  callerUserId: string
): Promise<GitHubRepoItem> {
  const docRes = await query<{
    id: string;
    organization_id: string;
    name: string;
    source_type: 'github';
    current_version_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, organization_id, name, source_type, current_version_id, created_at, updated_at
     FROM documents
     WHERE id = $1 AND source_type = 'github'`,
    [documentId]
  );

  const doc = docRes.rows[0];
  if (!doc) {
    throw new DocError('Repository not found or access denied.', 404, 'REPO_NOT_FOUND');
  }

  const member = await getOrganizationMember(doc.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Repository not found or access denied.', 404, 'REPO_NOT_FOUND');
  }

  let verRow: { version_number: number; content_hash: string; status: DocumentStatus; source_details: Record<string, unknown> } | undefined;
  if (doc.current_version_id) {
    const verRes = await query<{
      version_number: number;
      content_hash: string;
      status: DocumentStatus;
      source_details: Record<string, unknown>;
    }>(
      'SELECT version_number, content_hash, status, source_details FROM document_versions WHERE id = $1',
      [doc.current_version_id]
    );
    verRow = verRes.rows[0];
  }

  const details = verRow?.source_details || {};

  return {
    id: doc.id,
    organizationId: doc.organization_id,
    name: doc.name,
    sourceType: 'github',
    currentVersionId: doc.current_version_id,
    versionNumber: verRow?.version_number,
    commitSha: verRow?.content_hash,
    status: verRow?.status,
    repoOwner: typeof details.owner === 'string' ? details.owner : undefined,
    repoName: typeof details.repo === 'string' ? details.repo : undefined,
    repoRef: typeof details.ref === 'string' ? details.ref : undefined,
    fileCount: typeof details.filesProcessed === 'number' ? details.filesProcessed : undefined,
    chunkCount: typeof details.chunkCount === 'number' ? details.chunkCount : undefined,
    totalBytes: typeof details.totalBytes === 'number' ? details.totalBytes : undefined,
    createdAt: doc.created_at.toISOString(),
    updatedAt: doc.updated_at.toISOString(),
  };
}

/**
 * Retrieves the source code and line range for a file in an imported repository.
 * Powers the internal safe source viewer without relying on arbitrary client-supplied paths.
 */
export async function getRepositorySource(params: {
  documentId: string;
  filePath: string;
  versionId?: string | undefined;
  callerUserId: string;
}): Promise<GitHubSourceViewerResponse> {
  const { documentId, filePath, versionId, callerUserId } = params;

  const docRes = await query<{
    id: string;
    organization_id: string;
    name: string;
    source_type: 'github';
    current_version_id: string | null;
  }>(
    `SELECT id, organization_id, name, source_type, current_version_id
     FROM documents
     WHERE id = $1 AND source_type = 'github'`,
    [documentId]
  );

  const doc = docRes.rows[0];
  if (!doc) {
    throw new DocError('Repository not found or access denied.', 404, 'REPO_NOT_FOUND');
  }

  const member = await getOrganizationMember(doc.organization_id, callerUserId);
  if (!member) {
    throw new DocError('Repository not found or access denied.', 404, 'REPO_NOT_FOUND');
  }

  const targetVersionId = versionId || doc.current_version_id;
  if (!targetVersionId) {
    throw new DocError('Repository has no active or ready versions.', 404, 'NO_READY_VERSION');
  }

  const verRes = await query<{
    content_hash: string;
    source_details: Record<string, unknown>;
  }>(
    'SELECT content_hash, source_details FROM document_versions WHERE id = $1 AND document_id = $2',
    [targetVersionId, doc.id]
  );

  const ver = verRes.rows[0];
  if (!ver) {
    throw new DocError('Specified repository version was not found.', 404, 'VERSION_NOT_FOUND');
  }

  const details = ver.source_details || {};
  const owner = String(details.owner || '');
  const repo = String(details.repo || '');
  const ref = String(details.ref || 'main');
  const commitSha = ver.content_hash;

  // Fetch all chunks for this file in this version to reconstruct the source
  const chunksRes = await query<{
    content: string;
    line_start: number;
    line_end: number;
    chunk_index: number;
  }>(
    `SELECT content, line_start, line_end, chunk_index
     FROM chunks
     WHERE document_version_id = $1 AND file_path = $2
     ORDER BY chunk_index ASC`,
    [targetVersionId, filePath]
  );

  if (chunksRes.rows.length === 0) {
    throw new DocError(
      `File "${filePath}" was not found or was excluded during repository ingestion.`,
      404,
      'FILE_NOT_FOUND'
    );
  }

  // Reconstruct source code lines deterministically using line ranges
  const linesMap = new Map<number, string>();
  let minLine = Number.MAX_SAFE_INTEGER;
  let maxLine = 0;

  for (const chunk of chunksRes.rows) {
    const chunkLines = chunk.content.split('\n');
    const start = chunk.line_start ?? 1;
    const end = chunk.line_end ?? (start + chunkLines.length - 1);
    if (start < minLine) minLine = start;
    if (end > maxLine) maxLine = end;

    for (let i = 0; i < chunkLines.length; i++) {
      const lineNum = start + i;
      if (lineNum <= end && !linesMap.has(lineNum)) {
        linesMap.set(lineNum, chunkLines[i]!);
      }
    }
  }

  const reconstructedLines: string[] = [];
  const startLine = minLine === Number.MAX_SAFE_INTEGER ? 1 : minLine;
  const endLine = maxLine === 0 ? startLine : maxLine;

  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    reconstructedLines.push(linesMap.get(lineNum) ?? '');
  }

  const fullContent = reconstructedLines.join('\n');
  const lineStart = startLine;
  const lineEnd = endLine;
  const totalLines = reconstructedLines.length;
  const language = detectLanguage(filePath);

  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const githubUrl = owner && repo && commitSha
    ? `https://github.com/${owner}/${repo}/blob/${commitSha}/${encodedPath}#L${lineStart}-L${lineEnd}`
    : undefined;

  return {
    documentId: doc.id,
    documentName: doc.name,
    filePath,
    language,
    commitSha,
    repoOwner: owner,
    repoName: repo,
    repoRef: ref,
    lineStart,
    lineEnd,
    totalLines,
    content: fullContent,
    githubUrl,
  };
}
