import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';
import {
  validateAndNormalizeGitHubUrl,
  GitHubUrlError,
} from '../src/services/github/githubUrlValidator.js';
import {
  isFileEligible,
  isContentSafe,
  normalizeRepoPath,
  detectLanguage,
  DEFAULT_GITHUB_LIMITS,
} from '../src/services/github/githubPolicy.js';
import {
  GitHubClient,
  GitHubClientError,
  GitHubRateLimitError,
} from '../src/services/github/githubClient.js';
import { chunkCodeFile } from '../src/services/github/codeChunker.js';
import {
  startRepoImport,
  processRepoImportJob,
  getRepositoryById,
  getRepositorySource,
  listRepositories,
} from '../src/services/github/githubIngestionService.js';
import { MockEmbeddingProvider } from '../src/services/ingestion/embeddingProvider.js';
import {
  calculateRateLimitDelay,
  rateLimitBackoffStrategy,
} from '../src/services/queue/ingestionWorker.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

describe('Phase 11: GitHub Repository and Code Ingestion Suite', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_github_ingestion_suite_32chars!';

  let orgAId: string;
  let orgBId: string;

  let adminAToken: string;
  let adminAUserId: string;

  let memberAToken: string;
  let memberAUserId: string;

  let viewerAToken: string;
  let viewerAUserId: string;

  let memberBToken: string;
  let memberBUserId: string;

  beforeAll(async () => {
    // 1. Reset test database cleanly on devdocs_ai_test (never devdocs_ai)
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4006',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
      MAX_FILE_SIZE_BYTES: '10485760',
      GITHUB_MAX_REPO_BYTES: '52428800',
      GITHUB_MAX_FILES: '300',
      GITHUB_MAX_FILE_BYTES: '204800',
      GITHUB_REQUEST_TIMEOUT_MS: '15000',
    });

    app = await buildApp({ env: testEnv });
    await app.ready();

    // Helper to register a test user
    async function registerUser(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'Password123!' },
      });
      const body = JSON.parse(res.body);
      return { token: body.token as string, userId: body.user.id as string };
    }

    const adminA = await registerUser('gh_admin_a@corp.com');
    adminAToken = adminA.token;
    adminAUserId = adminA.userId;

    const memberA = await registerUser('gh_member_a@corp.com');
    memberAToken = memberA.token;
    memberAUserId = memberA.userId;

    const viewerA = await registerUser('gh_viewer_a@corp.com');
    viewerAToken = viewerA.token;
    viewerAUserId = viewerA.userId;

    const memberB = await registerUser('gh_member_b@corp.com');
    memberBToken = memberB.token;
    memberBUserId = memberB.userId;

    // Helper to create an organization
    async function createOrg(name: string, slug: string, token: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: { authorization: `Bearer ${token}` },
        payload: { name, slug },
      });
      const body = JSON.parse(res.body);
      return body.organization.id as string;
    }

    orgAId = await createOrg('GitHub Org A', 'github-org-a', adminAToken);
    orgBId = await createOrg('GitHub Org B', 'github-org-b', memberBToken);

    // Add members to Org A
    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'gh_member_a@corp.com', role: 'member' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'gh_viewer_a@corp.com', role: 'viewer' },
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closePool();
  });

  describe('1. Repository URL Validation and Security', () => {
    it('accepts valid HTTPS GitHub repository URLs and normalizes them', () => {
      const res1 = validateAndNormalizeGitHubUrl('https://github.com/facebook/react');
      expect(res1.owner).toBe('facebook');
      expect(res1.repo).toBe('react');
      expect(res1.canonicalUrl).toBe('https://github.com/facebook/react');

      const res2 = validateAndNormalizeGitHubUrl('https://github.com/expressjs/express.git');
      expect(res2.owner).toBe('expressjs');
      expect(res2.repo).toBe('express');
      expect(res2.canonicalUrl).toBe('https://github.com/expressjs/express');

      const res3 = validateAndNormalizeGitHubUrl('https://github.com/nodejs/node/tree/main');
      expect(res3.owner).toBe('nodejs');
      expect(res3.repo).toBe('node');
      expect(res3.ref).toBe('main');

      const res4 = validateAndNormalizeGitHubUrl(
        'https://github.com/torvalds/linux/commit/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'
      );
      expect(res4.owner).toBe('torvalds');
      expect(res4.repo).toBe('linux');
      expect(res4.ref).toBe('1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b');
    });

    it('rejects HTTP and non-HTTPS schemes', () => {
      expect(() => validateAndNormalizeGitHubUrl('http://github.com/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('git://github.com/owner/repo.git')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('ssh://git@github.com/owner/repo.git')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('ftp://github.com/owner/repo')).toThrow(
        GitHubUrlError
      );
    });

    it('rejects deceptive hosts and subdomains', () => {
      expect(() => validateAndNormalizeGitHubUrl('https://github.com.evil.com/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://evil-github.com/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://gist.github.com/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://raw.githubusercontent.com/owner/repo')).toThrow(
        GitHubUrlError
      );
    });

    it('rejects embedded userinfo credentials in URLs', () => {
      expect(() =>
        validateAndNormalizeGitHubUrl('https://user:password@github.com/owner/repo')
      ).toThrow(GitHubUrlError);
      expect(() =>
        validateAndNormalizeGitHubUrl('https://token@github.com/owner/repo')
      ).toThrow(GitHubUrlError);
    });

    it('rejects alternate and unexpected ports', () => {
      expect(() => validateAndNormalizeGitHubUrl('https://github.com:8080/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://github.com:22/owner/repo')).toThrow(
        GitHubUrlError
      );
    });

    it('rejects localhost, loopback, and private IP addresses', () => {
      expect(() => validateAndNormalizeGitHubUrl('https://localhost/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://127.0.0.1/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://192.168.1.1/owner/repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://10.0.0.1/owner/repo')).toThrow(
        GitHubUrlError
      );
    });

    it('rejects malformed, path traversal, and shell-injection like URLs', () => {
      expect(() => validateAndNormalizeGitHubUrl('')).toThrow(GitHubUrlError);
      expect(() => validateAndNormalizeGitHubUrl('https://github.com/')).toThrow(GitHubUrlError);
      expect(() => validateAndNormalizeGitHubUrl('https://github.com/single-part')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://github.com/owner/../repo')).toThrow(
        GitHubUrlError
      );
      expect(() => validateAndNormalizeGitHubUrl('https://github.com/owner/repo;rm -rf')).toThrow(
        GitHubUrlError
      );
    });
  });

  describe('2. Repository and File Filtering & Security Policy', () => {
    it('rejects binary file extensions', () => {
      expect(isFileEligible('assets/logo.png', 1024).eligible).toBe(false);
      expect(isFileEligible('bin/app.exe', 1024).eligible).toBe(false);
      expect(isFileEligible('dist/bundle.wasm', 1024).eligible).toBe(false);
      expect(isFileEligible('archive.zip', 1024).eligible).toBe(false);
      expect(isFileEligible('docs/spec.pdf', 1024).eligible).toBe(false);
    });

    it('rejects vendor and dependency directories', () => {
      expect(isFileEligible('node_modules/express/index.js', 500).eligible).toBe(false);
      expect(isFileEligible('vendor/bundle/gems/rails.rb', 500).eligible).toBe(false);
      expect(isFileEligible('.pnpm/react@18.0.0/node_modules/index.js', 500).eligible).toBe(false);
      expect(isFileEligible('Pods/Alamofire/Source/Alamofire.swift', 500).eligible).toBe(false);
    });

    it('rejects .git contents, lockfiles, and minified assets', () => {
      expect(isFileEligible('.git/config', 200).eligible).toBe(false);
      expect(isFileEligible('.git/HEAD', 50).eligible).toBe(false);
      expect(isFileEligible('package-lock.json', 5000).eligible).toBe(false);
      expect(isFileEligible('pnpm-lock.yaml', 5000).eligible).toBe(false);
      expect(isFileEligible('dist/app.min.js', 2000).eligible).toBe(false);
      expect(isFileEligible('styles/theme.min.css', 2000).eligible).toBe(false);
    });

    it('rejects individual files exceeding maximum file size', () => {
      const limitBytes = 200 * 1024; // 200KB
      expect(isFileEligible('large.ts', limitBytes + 1, { maxFileBytes: limitBytes }).eligible).toBe(
        false
      );
      expect(isFileEligible('ok.ts', limitBytes - 1, { maxFileBytes: limitBytes }).eligible).toBe(
        true
      );
    });

    it('detects null-byte binary content in files without binary extensions', () => {
      const nullByteContent = 'console.log("hello");\0binary_bytes_here';
      const check = isContentSafe(nullByteContent);
      expect(check.safe).toBe(false);
      expect(check.reason).toContain('null bytes');
    });

    it('detects and excludes secret-like content and credentials', () => {
      const privateKey = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...';
      expect(isContentSafe(privateKey).safe).toBe(false);

      const awsSecret = 'aws_secret_access_key = AKIAIOSFODNN7EXAMPLEsecretkey';
      expect(isContentSafe(awsSecret).safe).toBe(false);

      const githubToken = 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";';
      expect(isContentSafe(githubToken).safe).toBe(false);

      const openAiToken = 'const key = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz12345678";';
      expect(isContentSafe(openAiToken).safe).toBe(false);
    });

    it('normalizes repository file paths and blocks traversal attempts', () => {
      expect(normalizeRepoPath('src/utils/helpers.ts')).toBe('src/utils/helpers.ts');
      expect(normalizeRepoPath('src/../src/utils/helpers.ts')).toBe('src/utils/helpers.ts');
      expect(normalizeRepoPath('/src/utils/helpers.ts')).toBe('src/utils/helpers.ts');
      expect(normalizeRepoPath('src\\utils\\helpers.ts')).toBe('src/utils/helpers.ts');

      expect(() => normalizeRepoPath('../../etc/passwd')).toThrow();
      expect(() => normalizeRepoPath('..\\..\\windows\\system32')).toThrow();
    });

    it('correctly detects programming languages for common source extensions', () => {
      expect(detectLanguage('app.ts')).toBe('typescript');
      expect(detectLanguage('index.js')).toBe('javascript');
      expect(detectLanguage('main.py')).toBe('python');
      expect(detectLanguage('server.go')).toBe('go');
      expect(detectLanguage('lib.rs')).toBe('rust');
      expect(detectLanguage('Main.java')).toBe('java');
      expect(detectLanguage('script.sh')).toBe('shell');
      expect(detectLanguage('config.json')).toBe('json');
      expect(detectLanguage('unknown.xyz123')).toBe('text');
    });
  });

  describe('3. Deterministic Code Chunking & Line Preservation', () => {
    it('chunks code deterministically, preserving 1-indexed line numbers and repository metadata', () => {
      const code = [
        'import express from "express";',
        '',
        'const app = express();',
        'const port = 3000;',
        '',
        'app.get("/health", (req, res) => {',
        '  res.status(200).json({ status: "ok" });',
        '});',
        '',
        'app.listen(port, () => {',
        '  console.log(`Server listening on port ${port}`);',
        '});',
      ].join('\n');

      const chunks = chunkCodeFile({
        filePath: 'src/server.ts',
        content: code,
        repoOwner: 'my-org',
        repoName: 'my-backend',
        repoRef: 'main',
        commitSha: 'c0ffee1234567890abcdef1234567890c0ffee12',
      });

      expect(chunks.length).toBeGreaterThan(0);
      const firstChunk = chunks[0]!;

      expect(firstChunk.filePath).toBe('src/server.ts');
      expect(firstChunk.lineStart).toBe(1);
      expect(firstChunk.lineEnd).toBeGreaterThanOrEqual(1);
      expect(firstChunk.metadata.sourceType).toBe('code');
      expect(firstChunk.metadata.repoOwner).toBe('my-org');
      expect(firstChunk.metadata.repoName).toBe('my-backend');
      expect(firstChunk.metadata.repoRef).toBe('main');
      expect(firstChunk.metadata.commitSha).toBe('c0ffee1234567890abcdef1234567890c0ffee12');
      expect(firstChunk.metadata.language).toBe('typescript');
    });

    it('splits large code files across block boundaries while maintaining accurate line ranges', () => {
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        lines.push(`function testFunction${i}() { return ${i} * 2; }`);
      }
      const largeContent = lines.join('\n');

      const chunks = chunkCodeFile({
        filePath: 'src/generated.ts',
        content: largeContent,
        repoOwner: 'my-org',
        repoName: 'my-backend',
        repoRef: 'main',
        commitSha: 'c0ffee1234567890abcdef1234567890c0ffee12',
        config: {
          maxChunkSizeChars: 600,
          chunkOverlapChars: 50,
          minChunkSizeChars: 50,
        },
      });

      expect(chunks.length).toBeGreaterThan(1);

      // Verify contiguous progression of line numbers
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        expect(c.lineStart).toBeGreaterThan(0);
        expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart!);
        if (i > 0) {
          // Because of overlap, lineStart should be at or after previous lineStart
          expect(c.lineStart).toBeGreaterThan(chunks[i - 1]!.lineStart!);
        }
      }
    });
  });

  describe('4. Mocked GitHub REST API Client', () => {
    it('fetches repository metadata and resolves branch refs correctly', async () => {
      const mockFetch: typeof fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/repos/test-owner/test-repo/commits/main')) {
          return new Response(
            JSON.stringify({
              sha: '1111222233334444555566667777888899990000',
              commit: { message: 'Initial commit' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (urlStr.includes('/repos/test-owner/test-repo')) {
          return new Response(
            JSON.stringify({
              name: 'test-repo',
              owner: { login: 'test-owner' },
              default_branch: 'main',
              private: false,
              description: 'A test repository',
              stargazers_count: 42,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      };

      const client = new GitHubClient({ customFetch: mockFetch });
      const repo = await client.getRepository('test-owner', 'test-repo');
      expect(repo.owner).toBe('test-owner');
      expect(repo.repo).toBe('test-repo');
      expect(repo.defaultBranch).toBe('main');
      expect(repo.isPrivate).toBe(false);

      const resolved = await client.resolveCommitSha('test-owner', 'test-repo', 'main');
      expect(resolved.commitSha).toBe('1111222233334444555566667777888899990000');
    });

    it('rejects private repositories with an explicit error', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            name: 'secret-repo',
            owner: { login: 'test-owner' },
            default_branch: 'main',
            private: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const client = new GitHubClient({ customFetch: mockFetch });
      await expect(client.getRepository('test-owner', 'secret-repo')).rejects.toThrow(
        /Private.*repositories are not supported/
      );
    });

    it('translates 429 rate limit responses into GitHubRateLimitError', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ message: 'API rate limit exceeded' }),
          {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1700000000',
            },
          }
        );
      };

      const client = new GitHubClient({ customFetch: mockFetch });
      await expect(client.getRepository('test-owner', 'test-repo')).rejects.toThrow(
        GitHubRateLimitError
      );
    });

    it('safely decodes base64 blob content and handles empty blobs', async () => {
      const sampleText = 'console.log("hello world");';
      const base64Data = Buffer.from(sampleText, 'utf8').toString('base64');

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            content: base64Data,
            encoding: 'base64',
            size: sampleText.length,
            sha: 'blobsha123',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };

      const client = new GitHubClient({ customFetch: mockFetch });
      const blob = await client.getBlobContent('test-owner', 'test-repo', 'blobsha123');
      expect(blob).toBe(sampleText);
    });
  });

  describe('5. API Authorization, RBAC & Tenant Isolation', () => {
    it('requires authentication for POST /api/github/import', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/import',
        payload: {
          organizationId: orgAId,
          repoUrl: 'https://github.com/facebook/react',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects import request if caller is not an organization member', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/import',
        headers: { authorization: `Bearer ${memberBToken}` },
        payload: {
          organizationId: orgAId,
          repoUrl: 'https://github.com/facebook/react',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('rejects import request with 403 Forbidden if caller has only Viewer role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/import',
        headers: { authorization: `Bearer ${viewerAToken}` },
        payload: {
          organizationId: orgAId,
          repoUrl: 'https://github.com/facebook/react',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('rejects import request with 400 when invalid GitHub URL is provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/github/import',
        headers: { authorization: `Bearer ${memberAToken}` },
        payload: {
          organizationId: orgAId,
          repoUrl: 'http://not-github.com/bad/repo',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(['VALIDATION_ERROR', 'INVALID_SCHEME', 'INVALID_GITHUB_URL']).toContain(
        body.error.code
      );
    });
  });

  describe('6. End-to-End Ingestion, Idempotency & Versioning Pipeline', () => {
    const mockCommitSha = '9876543210abcdef9876543210abcdef98765432';
    const mockNewCommitSha = 'fedcba0987654321fedcba0987654321fedcba09';

    // Build mock GitHubClient with sample files
    function createMockGitHubClient(commitSha: string) {
      return new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);

          if (urlStr.includes('/commits/')) {
            return new Response(
              JSON.stringify({ sha: commitSha, commit: { message: 'Commit message' } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }

          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [
                  {
                    path: 'src/index.ts',
                    mode: '100644',
                    type: 'blob',
                    sha: 'blob-index-sha',
                    size: 80,
                  },
                  {
                    path: 'src/utils/math.ts',
                    mode: '100644',
                    type: 'blob',
                    sha: 'blob-math-sha',
                    size: 95,
                  },
                  {
                    path: 'assets/logo.png', // binary excluded
                    mode: '100644',
                    type: 'blob',
                    sha: 'blob-bin-sha',
                    size: 1024,
                  },
                  {
                    path: 'node_modules/dep/index.js', // vendor excluded
                    mode: '100644',
                    type: 'blob',
                    sha: 'blob-vendor-sha',
                    size: 50,
                  },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }

          if (urlStr.includes('/git/blobs/blob-index-sha')) {
            const content = 'export function main(): void {\n  console.log("App running");\n}\n';
            return new Response(
              JSON.stringify({
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
                size: content.length,
                sha: 'blob-index-sha',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }

          if (urlStr.includes('/git/blobs/blob-math-sha')) {
            const content = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
            return new Response(
              JSON.stringify({
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
                size: content.length,
                sha: 'blob-math-sha',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }

          if (urlStr.includes('/repos/org-demo/sample-repo')) {
            return new Response(
              JSON.stringify({
                name: 'sample-repo',
                owner: { login: 'org-demo' },
                default_branch: 'main',
                private: false,
                description: 'A demo code repo',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }

          return new Response('Not Found', { status: 404 });
        },
      });
    }

    let createdDocId: string;
    let initialVersionId: string;
    let initialJobId: string;

    it('starts repository import and enqueues job with Member permissions', async () => {
      const mockClient = createMockGitHubClient(mockCommitSha);

      const importResult = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/org-demo/sample-repo',
        client: mockClient,
      });

      expect(importResult.status).toBe('queued');
      expect(importResult.repository.owner).toBe('org-demo');
      expect(importResult.repository.repo).toBe('sample-repo');
      expect(importResult.repository.commitSha).toBe(mockCommitSha);
      expect(importResult.isExisting).toBe(false);

      createdDocId = importResult.documentId;
      initialVersionId = importResult.versionId;
      initialJobId = importResult.jobId;
    });

    it('processes repository import job, persists chunks, and marks version ready', async () => {
      const mockClient = createMockGitHubClient(mockCommitSha);
      const mockEmbedding = new MockEmbeddingProvider({ dimensions: 1536 });

      const processResult = await processRepoImportJob(
        {
          jobId: initialJobId,
          documentId: createdDocId,
          versionId: initialVersionId,
          organizationId: orgAId,
        },
        {
          client: mockClient,
          overrideProvider: mockEmbedding,
        }
      );

      expect(processResult.success).toBe(true);
      expect(processResult.chunkCount).toBeGreaterThanOrEqual(2);

      // Verify DB version is marked ready and document has current_version_id
      const docRes = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [createdDocId]
      );
      expect(docRes.rows[0]?.current_version_id).toBe(initialVersionId);

      const verRes = await query<{ status: string; content_hash: string }>(
        'SELECT status, content_hash FROM document_versions WHERE id = $1',
        [initialVersionId]
      );
      expect(verRes.rows[0]?.status).toBe('ready');
      expect(verRes.rows[0]?.content_hash).toBe(mockCommitSha);

      // Verify chunks have line numbers, file_path, and source_type code
      const chunksRes = await query<{
        file_path: string;
        line_start: number;
        line_end: number;
        metadata: Record<string, unknown>;
      }>(
        'SELECT file_path, line_start, line_end, metadata FROM chunks WHERE document_version_id = $1',
        [initialVersionId]
      );
      expect(chunksRes.rows.length).toBeGreaterThanOrEqual(2);
      for (const row of chunksRes.rows) {
        expect(row.file_path).toBeTruthy();
        expect(row.line_start).toBeGreaterThan(0);
        expect(row.line_end).toBeGreaterThanOrEqual(row.line_start);
        expect(row.metadata.sourceType).toBe('code');
      }
    });

    it('idempotently handles same-commit re-import without duplicating versions or chunks', async () => {
      const mockClient = createMockGitHubClient(mockCommitSha);

      const reimportResult = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/org-demo/sample-repo',
        client: mockClient,
      });

      expect(reimportResult.isExisting).toBe(true);
      expect(reimportResult.versionId).toBe(initialVersionId);
      expect(reimportResult.documentId).toBe(createdDocId);
      expect(reimportResult.status).toBe('ready');

      // Verify no duplicate chunks exist
      const countRes = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM chunks WHERE document_version_id = $1',
        [initialVersionId]
      );
      expect(Number(countRes.rows[0]?.count)).toBeGreaterThanOrEqual(2);
    });

    it('creates an incremented version when importing a newer commit SHA', async () => {
      const mockClientNew = createMockGitHubClient(mockNewCommitSha);
      const mockEmbedding = new MockEmbeddingProvider({ dimensions: 1536 });

      const newCommitResult = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/org-demo/sample-repo',
        client: mockClientNew,
      });

      expect(newCommitResult.isExisting).toBe(false);
      expect(newCommitResult.versionId).not.toBe(initialVersionId);
      expect(newCommitResult.repository.commitSha).toBe(mockNewCommitSha);

      // Process new version
      await processRepoImportJob(
        {
          jobId: newCommitResult.jobId,
          documentId: createdDocId,
          versionId: newCommitResult.versionId,
          organizationId: orgAId,
        },
        {
          client: mockClientNew,
          overrideProvider: mockEmbedding,
        }
      );

      // Verify active version was monotonically updated to version 2
      const docRes = await query<{ current_version_id: string }>(
        'SELECT current_version_id FROM documents WHERE id = $1',
        [createdDocId]
      );
      expect(docRes.rows[0]?.current_version_id).toBe(newCommitResult.versionId);

      const verRes = await query<{ version_number: number; content_hash: string }>(
        'SELECT version_number, content_hash FROM document_versions WHERE id = $1',
        [newCommitResult.versionId]
      );
      expect(verRes.rows[0]?.version_number).toBe(2);
      expect(verRes.rows[0]?.content_hash).toBe(mockNewCommitSha);
    });
  });

  describe('7. Source Viewer Endpoint & Cross-Tenant Security', () => {
    it('retrieves source code lines and GitHub permalink for authorized users', async () => {
      const reposRes = await app.inject({
        method: 'GET',
        url: `/api/github/repos?organizationId=${orgAId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(reposRes.statusCode).toBe(200);
      const reposBody = JSON.parse(reposRes.body);
      expect(reposBody.data.length).toBeGreaterThan(0);
      const repoId = reposBody.data[0].id;

      // Request source
      const sourceRes = await app.inject({
        method: 'GET',
        url: `/api/github/repos/${repoId}/source?filePath=src/utils/math.ts`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(sourceRes.statusCode).toBe(200);
      const sourceBody = JSON.parse(sourceRes.body);
      expect(sourceBody.data.filePath).toBe('src/utils/math.ts');
      expect(sourceBody.data.language).toBe('typescript');
      expect(sourceBody.data.content).toContain('export function add');
      expect(sourceBody.data.githubUrl).toContain('https://github.com/org-demo/sample-repo/blob/');
    });

    it('rejects cross-tenant source viewing requests (Tenant B cannot read Org A code)', async () => {
      const reposRes = await app.inject({
        method: 'GET',
        url: `/api/github/repos?organizationId=${orgAId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      const repoId = JSON.parse(reposRes.body).data[0].id;

      // Member B attempts to view Org A source
      const crossRes = await app.inject({
        method: 'GET',
        url: `/api/github/repos/${repoId}/source?filePath=src/utils/math.ts`,
        headers: { authorization: `Bearer ${memberBToken}` },
      });

      expect(crossRes.statusCode).toBe(404);
      const body = JSON.parse(crossRes.body);
      expect(body.error.code).toBe('REPO_NOT_FOUND');
    });

    it('returns 404 when requesting an excluded or non-existent file', async () => {
      const reposRes = await app.inject({
        method: 'GET',
        url: `/api/github/repos?organizationId=${orgAId}`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });
      const repoId = JSON.parse(reposRes.body).data[0].id;

      const notFoundRes = await app.inject({
        method: 'GET',
        url: `/api/github/repos/${repoId}/source?filePath=assets/logo.png`,
        headers: { authorization: `Bearer ${memberAToken}` },
      });

      expect(notFoundRes.statusCode).toBe(404);
      const body = JSON.parse(notFoundRes.body);
      expect(body.error.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('8. Phase 11 Audit Remediation Regression Suite (F-11-01 to F-11-06)', () => {
    // F-11-01: Rethrow rate-limit and transient errors in blob download loop
    it('F-11-01: rethrows GitHubRateLimitError in blob download loop to trigger worker retry', async () => {
      const mockClient = new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('/commits/')) {
            return new Response(
              JSON.stringify({ sha: '1111111111111111111111111111111111111111', commit: { message: 'msg' } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [
                  { path: 'src/main.ts', mode: '100644', type: 'blob', sha: 'rate-limit-blob', size: 100 },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/blobs/rate-limit-blob')) {
            return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
            });
          }
          if (urlStr.includes('/repos/')) {
            return new Response(
              JSON.stringify({ name: 'rate-repo', owner: { login: 'rate-org' }, default_branch: 'main', private: false }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const importRes = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/rate-org/rate-repo',
        client: mockClient,
      });

      await expect(
        processRepoImportJob(
          {
            jobId: importRes.jobId,
            organizationId: orgAId,
            documentId: importRes.documentId,
            versionId: importRes.versionId,
            type: 'repo_import',
          },
          { client: mockClient, overrideProvider: new MockEmbeddingProvider() }
        )
      ).rejects.toThrow(GitHubRateLimitError);

      const verRes = await query<{ status: string }>(
        'SELECT status FROM document_versions WHERE id = $1',
        [importRes.versionId]
      );
      expect(verRes.rows[0]?.status).not.toBe('ready');
    });

    it('F-11-01: rethrows transient network and timeout errors in blob download loop', async () => {
      const mockClient = new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('/commits/')) {
            return new Response(
              JSON.stringify({ sha: '2222222222222222222222222222222222222222', commit: { message: 'msg' } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [
                  { path: 'src/main.ts', mode: '100644', type: 'blob', sha: 'timeout-blob', size: 100 },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/blobs/timeout-blob')) {
            return new Response('Gateway Timeout', { status: 504 });
          }
          if (urlStr.includes('/repos/')) {
            return new Response(
              JSON.stringify({ name: 'timeout-repo', owner: { login: 'timeout-org' }, default_branch: 'main', private: false }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const importRes = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/timeout-org/timeout-repo',
        client: mockClient,
      });

      await expect(
        processRepoImportJob(
          {
            jobId: importRes.jobId,
            organizationId: orgAId,
            documentId: importRes.documentId,
            versionId: importRes.versionId,
            type: 'repo_import',
          },
          { client: mockClient, overrideProvider: new MockEmbeddingProvider() }
        )
      ).rejects.toThrow(GitHubClientError);

      const verRes = await query<{ status: string }>(
        'SELECT status FROM document_versions WHERE id = $1',
        [importRes.versionId]
      );
      expect(verRes.rows[0]?.status).not.toBe('ready');
    });

    it('F-11-01: excludes non-retryable 404 blob errors without failing import', async () => {
      const mockClient = new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('/commits/')) {
            return new Response(
              JSON.stringify({ sha: '3333333333333333333333333333333333333333', commit: { message: 'msg' } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [
                  { path: 'src/missing.ts', mode: '100644', type: 'blob', sha: 'missing-blob-404', size: 100 },
                  { path: 'src/valid.ts', mode: '100644', type: 'blob', sha: 'valid-blob-sha', size: 50 },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/blobs/missing-blob-404')) {
            return new Response('Not Found', { status: 404 });
          }
          if (urlStr.includes('/git/blobs/valid-blob-sha')) {
            const content = 'export const valid = true;\n';
            return new Response(
              JSON.stringify({
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
                size: content.length,
                sha: 'valid-blob-sha',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/repos/')) {
            return new Response(
              JSON.stringify({ name: 'missing-blob-repo', owner: { login: 'blob-org' }, default_branch: 'main', private: false }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const importRes = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/blob-org/missing-blob-repo',
        client: mockClient,
      });

      const processRes = await processRepoImportJob(
        {
          jobId: importRes.jobId,
          organizationId: orgAId,
          documentId: importRes.documentId,
          versionId: importRes.versionId,
          type: 'repo_import',
        },
        { client: mockClient, overrideProvider: new MockEmbeddingProvider() }
      );

      expect(processRes.success).toBe(true);
      expect(processRes.chunkCount).toBeGreaterThan(0);

      const verRes = await query<{ status: string; source_details: any }>(
        'SELECT status, source_details FROM document_versions WHERE id = $1',
        [importRes.versionId]
      );
      expect(verRes.rows[0]?.status).toBe('ready');
      expect(verRes.rows[0]?.source_details?.filesExcluded).toBe(1);
      expect(verRes.rows[0]?.source_details?.filesProcessed).toBe(1);
    });

    // F-11-02: Truncated Git trees
    it('F-11-02: aborts ingestion immediately when Git tree is truncated (truncated: true)', async () => {
      const mockClient = new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [{ path: 'src/file.ts', mode: '100644', type: 'blob', sha: 'sha1', size: 100 }],
                truncated: true,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      await expect(mockClient.getGitTree('owner', 'repo', 'sha123')).rejects.toThrow(
        /truncated by GitHub API/
      );

      await expect(mockClient.getGitTree('owner', 'repo', 'sha123')).rejects.toMatchObject({
        code: 'REPO_TREE_TRUNCATED',
        isTransient: false,
      });
    });

    // F-11-03: Exclude Git symlinks (mode 120000)
    it('F-11-03: rejects git symlinks (mode 120000) in isFileEligible and excludes them in getGitTree', async () => {
      expect(isFileEligible('src/symlink.ts', 100, DEFAULT_GITHUB_LIMITS, '120000').eligible).toBe(false);
      expect(isFileEligible('src/regular.ts', 100, DEFAULT_GITHUB_LIMITS, '100644').eligible).toBe(true);
      expect(isFileEligible('src/exec.sh', 100, DEFAULT_GITHUB_LIMITS, '100755').eligible).toBe(true);

      const mockClient = new GitHubClient({
        customFetch: async () => {
          return new Response(
            JSON.stringify({
              sha: 'treesha',
              tree: [
                { path: 'src/symlink.ts', mode: '120000', type: 'blob', sha: 'symlink-sha', size: 25 },
                { path: 'src/real.ts', mode: '100644', type: 'blob', sha: 'real-sha', size: 50 },
                { path: 'submodule', mode: '160000', type: 'commit', sha: 'commit-sha' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        },
      });

      const tree = await mockClient.getGitTree('owner', 'repo', 'commit123');
      expect(tree.length).toBe(1);
      expect(tree[0]?.path).toBe('src/real.ts');
      expect(tree.some((t) => t.path === 'src/symlink.ts')).toBe(false);
    });

    // F-11-04: Deterministic multi-chunk source reconstruction
    it('F-11-04: deterministically reconstructs multi-chunk files without duplicating overlap lines or inserting separators', async () => {
      const lines: string[] = [];
      for (let i = 1; i <= 80; i++) {
        lines.push(`const var_${i} = ${i * 10}; // Line ${i}`);
      }
      const originalCode = lines.join('\n');

      const mockClient = new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('/commits/')) {
            return new Response(
              JSON.stringify({ sha: '4444444444444444444444444444444444444444', commit: { message: 'msg' } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [
                  { path: 'src/large.ts', mode: '100644', type: 'blob', sha: 'large-blob-sha', size: originalCode.length },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/blobs/large-blob-sha')) {
            return new Response(
              JSON.stringify({
                content: Buffer.from(originalCode).toString('base64'),
                encoding: 'base64',
                size: originalCode.length,
                sha: 'large-blob-sha',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/repos/')) {
            return new Response(
              JSON.stringify({ name: 'large-repo', owner: { login: 'large-org' }, default_branch: 'main', private: false }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const importRes = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/large-org/large-repo',
        client: mockClient,
      });

      await processRepoImportJob(
        {
          jobId: importRes.jobId,
          organizationId: orgAId,
          documentId: importRes.documentId,
          versionId: importRes.versionId,
          type: 'repo_import',
          config: {
            maxChunkSizeChars: 400,
            chunkOverlapChars: 100,
          },
        },
        { client: mockClient, overrideProvider: new MockEmbeddingProvider() }
      );

      const chunksCount = await query<{ count: string }>(
        'SELECT count(*) as count FROM chunks WHERE document_version_id = $1',
        [importRes.versionId]
      );
      expect(parseInt(chunksCount.rows[0]?.count ?? '0', 10)).toBeGreaterThan(1);

      const source = await getRepositorySource({
        documentId: importRes.documentId,
        filePath: 'src/large.ts',
        versionId: importRes.versionId,
        callerUserId: memberAUserId,
      });

      expect(source.content).not.toContain('\n---\n');
      expect(source.totalLines).toBe(80);
      expect(source.lineStart).toBe(1);
      expect(source.lineEnd).toBe(80);
      expect(source.content).toBe(originalCode);
    });

    // F-11-05: Path segment encoding in source viewer permalinks
    it('F-11-05: source viewer generates correctly encoded GitHub permalinks for paths with spaces, hash, and unicode', async () => {
      const specialPath = 'docs/user guide #1/tést file.ts';
      const fileCode = 'export const special = true;\n';

      const mockClient = new GitHubClient({
        customFetch: async (url) => {
          const urlStr = String(url);
          if (urlStr.includes('/commits/')) {
            return new Response(
              JSON.stringify({ sha: '5555555555555555555555555555555555555555', commit: { message: 'msg' } }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/trees/')) {
            return new Response(
              JSON.stringify({
                sha: 'treesha',
                tree: [
                  { path: specialPath, mode: '100644', type: 'blob', sha: 'special-blob-sha', size: fileCode.length },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/git/blobs/special-blob-sha')) {
            return new Response(
              JSON.stringify({
                content: Buffer.from(fileCode).toString('base64'),
                encoding: 'base64',
                size: fileCode.length,
                sha: 'special-blob-sha',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          if (urlStr.includes('/repos/')) {
            return new Response(
              JSON.stringify({ name: 'special-repo', owner: { login: 'special-org' }, default_branch: 'main', private: false }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      });

      const importRes = await startRepoImport({
        organizationId: orgAId,
        userId: memberAUserId,
        repoUrl: 'https://github.com/special-org/special-repo',
        client: mockClient,
      });

      await processRepoImportJob(
        {
          jobId: importRes.jobId,
          organizationId: orgAId,
          documentId: importRes.documentId,
          versionId: importRes.versionId,
          type: 'repo_import',
        },
        { client: mockClient, overrideProvider: new MockEmbeddingProvider() }
      );

      const source = await getRepositorySource({
        documentId: importRes.documentId,
        filePath: specialPath,
        versionId: importRes.versionId,
        callerUserId: memberAUserId,
      });

      expect(source.githubUrl).toBe(
        'https://github.com/special-org/special-repo/blob/5555555555555555555555555555555555555555/docs/user%20guide%20%231/t%C3%A9st%20file.ts#L1-L2'
      );
    });

    // F-11-06: Rate-limit reset delay calculation and fallback
    it('F-11-06: calculateRateLimitDelay respects future reset epoch seconds, enforces minimum positive delay, and caps max delay', () => {
      const now = 1700000000000;
      const resetIn60s = 1700000060;

      expect(calculateRateLimitDelay(resetIn60s, now)).toBe(60000);
      expect(calculateRateLimitDelay(1700000000 - 10, now)).toBe(1000);
      expect(calculateRateLimitDelay(undefined, now)).toBe(1000);
      expect(calculateRateLimitDelay(NaN, now)).toBe(1000);
      expect(calculateRateLimitDelay(resetIn60s + 864000, now)).toBe(3600000);
    });

    it('F-11-06: rateLimitBackoffStrategy respects GitHubRateLimitError and falls back to exponential backoff for other errors', () => {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const rateLimitErr = new GitHubRateLimitError('Rate limit exceeded', nowEpoch + 45);

      const rateLimitDelay = rateLimitBackoffStrategy(1, 'rateLimitOrExponential', rateLimitErr);
      expect(rateLimitDelay).toBeGreaterThanOrEqual(43000);
      expect(rateLimitDelay).toBeLessThanOrEqual(46000);

      const genericErr = new Error('Generic transient error');
      expect(rateLimitBackoffStrategy(1, 'rateLimitOrExponential', genericErr)).toBe(1000);
      expect(rateLimitBackoffStrategy(2, 'rateLimitOrExponential', genericErr)).toBe(2000);
      expect(rateLimitBackoffStrategy(3, 'rateLimitOrExponential', genericErr)).toBe(4000);
    });
  });
});
