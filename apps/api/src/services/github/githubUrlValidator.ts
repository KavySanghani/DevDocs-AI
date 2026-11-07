export class GitHubUrlError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'INVALID_GITHUB_URL',
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'GitHubUrlError';
    Object.setPrototypeOf(this, GitHubUrlError.prototype);
  }
}

export interface ValidatedGitHubUrl {
  owner: string;
  repo: string;
  ref?: string | undefined;
  canonicalUrl: string;
}

// GitHub username rules: alphanumeric or single hyphens; cannot begin or end with a hyphen; max 39 chars
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

// GitHub repository name rules: alphanumeric, underscore, hyphen, period; max 100 chars; cannot be . or ..
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Validates, sanitizes, and normalizes a user-supplied GitHub repository URL.
 * Enforces strict security constraints:
 * - Scheme must be exactly 'https:'
 * - Host must be strictly 'github.com' (no subdomains, deceptive hosts, or IP addresses)
 * - No userinfo credentials (username/password/token in URL)
 * - No custom/alternate ports (must be 443 or omitted)
 * - Safe path parsing with strict owner and repository regex validation
 * - Strips optional '.git' suffix
 */
export function validateAndNormalizeGitHubUrl(rawUrl: string): ValidatedGitHubUrl {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new GitHubUrlError('Repository URL is required and must be a string.', 'MISSING_URL', 400);
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 2000) {
    throw new GitHubUrlError('Repository URL exceeds maximum allowed length of 2000 characters.', 'URL_TOO_LONG', 400);
  }

  // Pre-check for deceptive backslash / URL-confusion tricks before URL constructor parses
  if (trimmed.includes('\\') || trimmed.includes('@')) {
    throw new GitHubUrlError(
      'Repository URL contains invalid characters or embedded userinfo credentials.',
      'INVALID_CHARACTERS',
      400
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GitHubUrlError(`Malformed repository URL: "${trimmed}".`, 'MALFORMED_URL', 400);
  }

  // 1. Enforce HTTPS scheme
  if (parsed.protocol !== 'https:') {
    throw new GitHubUrlError(
      `Unsupported URL scheme "${parsed.protocol}". Only HTTPS URLs are permitted.`,
      'INVALID_SCHEME',
      400
    );
  }

  // 2. Enforce strict hostname 'github.com'
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com') {
    throw new GitHubUrlError(
      `Unsupported repository host "${hostname}". Only public repositories hosted on "github.com" are supported.`,
      'INVALID_HOST',
      400
    );
  }

  // 3. Reject custom ports (must be default 443 or empty)
  if (parsed.port && parsed.port !== '443') {
    throw new GitHubUrlError(
      `Alternate port "${parsed.port}" is not permitted.`,
      'INVALID_PORT',
      400
    );
  }

  // 4. Reject embedded credentials in URL
  if (parsed.username || parsed.password) {
    throw new GitHubUrlError(
      'Embedded credentials in repository URL are forbidden.',
      'EMBEDDED_CREDENTIALS',
      400
    );
  }

  // 5. Parse and normalize path segments: /owner/repo[/tree/ref...]
  const rawPath = parsed.pathname.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  const segments = rawPath.split('/').filter(Boolean);

  if (segments.length < 2) {
    throw new GitHubUrlError(
      'GitHub repository URL must include both owner and repository name (e.g. "https://github.com/owner/repo").',
      'INCOMPLETE_PATH',
      400
    );
  }

  const rawOwner = segments[0]!;
  let rawRepo = segments[1]!;

  // Strip .git suffix if present
  if (rawRepo.endsWith('.git')) {
    rawRepo = rawRepo.slice(0, -4);
  }

  // Reject path traversal attempts like '..' or '.'
  if (rawOwner === '.' || rawOwner === '..' || rawRepo === '.' || rawRepo === '..') {
    throw new GitHubUrlError(
      'Path traversal elements are forbidden in repository path.',
      'PATH_TRAVERSAL',
      400
    );
  }

  // 6. Validate owner name against GitHub format rules
  if (!GITHUB_OWNER_REGEX.test(rawOwner)) {
    throw new GitHubUrlError(
      `Invalid repository owner name "${rawOwner}". Owner must be alphanumeric with single hyphens (max 39 chars).`,
      'INVALID_OWNER',
      400
    );
  }

  // 7. Validate repository name against GitHub format rules
  if (!GITHUB_REPO_REGEX.test(rawRepo)) {
    throw new GitHubUrlError(
      `Invalid repository name "${rawRepo}". Repository name must be alphanumeric, underscores, hyphens, or periods (max 100 chars).`,
      'INVALID_REPO',
      400
    );
  }

  // 8. Extract optional ref from path if user supplied a branch URL like /owner/repo/tree/branch-name or /owner/repo/commit/sha
  let extractedRef: string | undefined;
  if (
    segments.length >= 4 &&
    (segments[2] === 'tree' || segments[2] === 'blob' || segments[2] === 'commit')
  ) {
    extractedRef = segments.slice(3).join('/');
  }

  const canonicalUrl = `https://github.com/${rawOwner}/${rawRepo}`;

  return {
    owner: rawOwner,
    repo: rawRepo,
    ref: extractedRef,
    canonicalUrl,
  };
}
