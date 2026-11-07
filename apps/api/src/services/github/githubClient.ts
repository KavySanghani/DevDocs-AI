import { getEnv } from '../../config/env.js';

export class GitHubClientError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'GITHUB_CLIENT_ERROR',
    public readonly statusCode: number = 400,
    public readonly isTransient: boolean = false
  ) {
    super(message);
    this.name = 'GitHubClientError';
    Object.setPrototypeOf(this, GitHubClientError.prototype);
  }
}

export class GitHubRateLimitError extends GitHubClientError {
  constructor(message: string, public readonly resetEpochSeconds?: number) {
    super(message, 'GITHUB_RATE_LIMITED', 429, true);
    this.name = 'GitHubRateLimitError';
    Object.setPrototypeOf(this, GitHubRateLimitError.prototype);
  }
}

export interface GitHubRepoMetadata {
  owner: string;
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string | null;
  stars: number;
}

export interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number | undefined;
}

export interface GitHubClientOptions {
  token?: string | undefined;
  timeoutMs?: number | undefined;
  customFetch?: typeof fetch | undefined;
}

const ALLOWED_GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
]);

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options?: GitHubClientOptions) {
    const env = getEnv();
    this.token = options?.token ?? env.GITHUB_TOKEN;
    this.timeoutMs = options?.timeoutMs ?? env.GITHUB_REQUEST_TIMEOUT_MS ?? 15000;
    this.fetchFn = options?.customFetch ?? fetch;
  }

  /**
   * Safely executes a GET request against the official GitHub REST API.
   * Defensively enforces allowed hosts, handles timeouts, scrubs credentials from errors,
   * and maps GitHub rate limits to transient retryable errors.
   */
  private async safeGet<T>(endpointUrl: string): Promise<T> {
    const parsed = new URL(endpointUrl);
    if (!ALLOWED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new GitHubClientError(
        `Disallowed request target host "${parsed.hostname}". Requests must target official GitHub APIs.`,
        'DISALLOWED_TARGET',
        400,
        false
      );
    }

    const headers: Record<string, string> = {
      'User-Agent': 'DevDocs-AI',
      Accept: 'application/vnd.github.v3+json',
    };

    if (this.token && this.token.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.token.trim()}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchFn(endpointUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error', // Prevent redirection to untrusted third-party hosts
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new GitHubClientError(
          `GitHub API request timed out after ${this.timeoutMs}ms.`,
          'REQUEST_TIMEOUT',
          504,
          true
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new GitHubClientError(`GitHub network failure: ${msg}`, 'NETWORK_ERROR', 502, true);
    } finally {
      clearTimeout(timeout);
    }

    // Rate limiting detection
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetTime = res.headers.get('x-ratelimit-reset');
    const resetEpoch = resetTime ? parseInt(resetTime, 10) : undefined;

    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const resetMsg = resetEpoch ? ` (resets at epoch ${resetEpoch})` : '';
      throw new GitHubRateLimitError(
        `GitHub API rate limit exceeded${resetMsg}. Requests will be retried with backoff.`,
        resetEpoch
      );
    }

    if (res.status === 404) {
      throw new GitHubClientError(
        'GitHub repository or resource not found or is private.',
        'RESOURCE_NOT_FOUND',
        404,
        false
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new GitHubClientError(
        'GitHub API access denied or forbidden.',
        'ACCESS_DENIED',
        res.status,
        false
      );
    }

    if (!res.ok) {
      const is5xx = res.status >= 500 && res.status < 600;
      throw new GitHubClientError(
        `GitHub API error: HTTP ${res.status}`,
        'API_ERROR',
        res.status,
        is5xx
      );
    }

    return (await res.json()) as T;
  }

  /**
   * Retrieves repository metadata and verifies that the repository is public.
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata> {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const data = await this.safeGet<{
      private: boolean;
      default_branch: string;
      description: string | null;
      stargazers_count: number;
    }>(url);

    if (data.private) {
      throw new GitHubClientError(
        'Private GitHub repositories are not supported in Phase 11. Only public repositories can be imported.',
        'PRIVATE_REPO_NOT_SUPPORTED',
        400,
        false
      );
    }

    return {
      owner,
      repo,
      defaultBranch: data.default_branch || 'main',
      isPrivate: data.private,
      description: data.description,
      stars: data.stargazers_count ?? 0,
    };
  }

  /**
   * Resolves a branch name, tag, or ref to its exact 40-character commit SHA.
   */
  async resolveCommitSha(
    owner: string,
    repo: string,
    ref?: string | undefined
  ): Promise<{ commitSha: string; ref: string }> {
    const targetRef = ref && ref.trim() !== '' ? ref.trim() : (await this.getRepository(owner, repo)).defaultBranch;

    // If targetRef is already a 40-character SHA, verify it directly
    if (/^[0-9a-f]{40}$/i.test(targetRef)) {
      return { commitSha: targetRef.toLowerCase(), ref: targetRef.slice(0, 7) };
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(targetRef)}`;
    const commitData = await this.safeGet<{ sha: string }>(url);

    if (!commitData.sha) {
      throw new GitHubClientError(
        `Unable to resolve commit SHA for reference "${targetRef}".`,
        'COMMIT_RESOLUTION_FAILED',
        400,
        false
      );
    }

    return {
      commitSha: commitData.sha,
      ref: targetRef,
    };
  }

  /**
   * Retrieves the full recursive Git tree for a commit in a single API call.
   */
  async getGitTree(owner: string, repo: string, commitSha: string): Promise<GitHubTreeItem[]> {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`;
    const data = await this.safeGet<{
      tree: Array<{
        path: string;
        mode: string;
        type: string;
        sha: string;
        size?: number;
      }>;
      truncated?: boolean;
    }>(url);

    if (!Array.isArray(data.tree)) {
      return [];
    }

    if (data.truncated === true) {
      throw new GitHubClientError(
        'GitHub repository tree was truncated by GitHub API (>100,000 entries or response size limit). Incomplete repository import is prohibited.',
        'REPO_TREE_TRUNCATED',
        400,
        false
      );
    }

    return data.tree
      .filter((item) => item.type === 'blob' && item.mode !== '120000')
      .map((item) => ({
        path: item.path,
        mode: item.mode,
        type: 'blob' as const,
        sha: item.sha,
        size: item.size,
      }));
  }

  /**
   * Fetches the content of a blob by its SHA and decodes it safely to UTF-8 text.
   */
  async getBlobContent(owner: string, repo: string, blobSha: string): Promise<string> {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
    const data = await this.safeGet<{
      content: string;
      encoding: string;
      size: number;
    }>(url);

    if (data.encoding === 'base64') {
      const buffer = Buffer.from(data.content, 'base64');
      return buffer.toString('utf-8');
    }

    return data.content ?? '';
  }
}
