import path from 'node:path';

export interface GitHubResourceLimits {
  maxRepoBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_GITHUB_LIMITS: GitHubResourceLimits = {
  maxRepoBytes: 52428800, // 50 MB
  maxFiles: 300,
  maxFileBytes: 204800, // 200 KB
};

const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'bower_components',
  'pods',
  '.venv',
  'venv',
  'env',
  'site-packages',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.ds_store',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.turbo',
  '.gradle',
  'bin',
  'obj',
  '__pycache__',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.webp',
  '.bmp',
  '.tiff',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.class',
  '.pyc',
  '.pyo',
  '.o',
  '.a',
  '.lib',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.keystore',
  '.jks',
]);

const GENERATED_LOCK_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'go.sum',
  'mix.lock',
]);

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[a-zA-Z0-9_-]{20,}/,
];

/**
 * Normalizes a file path from a GitHub tree, ensuring it is clean, relative,
 * and does not attempt directory traversal out of the repository root.
 */
export function normalizeRepoPath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path must be a non-empty string.');
  }

  if (filePath.includes('\0')) {
    throw new Error(`File path contains illegal characters: "${filePath}"`);
  }

  // Convert backslashes to forward slashes
  const forward = filePath.replace(/\\/g, '/');
  // Strip leading slashes
  const stripped = forward.replace(/^\/+/, '');
  const normalized = path.posix.normalize(stripped);

  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Path traversal attempted in file path: "${filePath}"`);
  }

  return normalized;
}

/**
 * Evaluates whether a file in the repository tree is eligible for ingestion
 * according to the repository ignore policy, limits, and security rules.
 */
export function isFileEligible(
  filePath: string,
  fileSizeBytes?: number | undefined,
  limits: GitHubResourceLimits = DEFAULT_GITHUB_LIMITS,
  mode?: string | undefined
): { eligible: boolean; reason?: string } {
  // 0. Exclude Git symbolic links (mode 120000)
  if (mode === '120000') {
    return { eligible: false, reason: 'Symlink entries (mode 120000) are not eligible for ingestion.' };
  }

  let normalized: string;
  try {
    normalized = normalizeRepoPath(filePath);
  } catch (err) {
    return { eligible: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // 1. Check directory path components for ignored directories
  const parts = normalized.toLowerCase().split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i]!;
    if (IGNORED_DIRECTORY_NAMES.has(dir)) {
      return { eligible: false, reason: `Ignored directory: "${dir}"` };
    }
  }

  const filename = parts[parts.length - 1]!;
  const ext = path.extname(filename).toLowerCase();

  // 2. Exclude binary and media file extensions
  if (BINARY_EXTENSIONS.has(ext)) {
    return { eligible: false, reason: `Binary or media extension: "${ext}"` };
  }

  // 3. Exclude generated package manager lockfiles
  if (GENERATED_LOCK_FILES.has(filename)) {
    return { eligible: false, reason: `Generated lockfile: "${filename}"` };
  }

  // 4. Exclude minified code and bundles
  if (
    filename.endsWith('.min.js') ||
    filename.endsWith('.min.css') ||
    filename.endsWith('.bundle.js') ||
    filename.endsWith('.map')
  ) {
    return { eligible: false, reason: `Generated minified bundle or sourcemap: "${filename}"` };
  }

  // 5. Exclude secret-like configuration and credential files
  if (
    filename === '.env' ||
    filename.startsWith('.env.') ||
    filename === 'credentials.json' ||
    filename.startsWith('service-account') ||
    filename.startsWith('id_rsa') ||
    filename.startsWith('id_ed25519') ||
    filename.startsWith('id_ecdsa') ||
    filename.startsWith('id_dsa') ||
    ext === '.pem' ||
    ext === '.key' ||
    ext === '.p12' ||
    ext === '.pfx' ||
    filename.includes('secret')
  ) {
    return { eligible: false, reason: `Excluded secret or credential file: "${filename}"` };
  }

  // 6. Enforce individual file size limit
  if (typeof fileSizeBytes === 'number' && fileSizeBytes > limits.maxFileBytes) {
    return {
      eligible: false,
      reason: `File size (${fileSizeBytes} bytes) exceeds maximum allowed limit (${limits.maxFileBytes} bytes)`,
    };
  }

  return { eligible: true };
}

/**
 * Inspects downloaded text content for binary null bytes and high-entropy secret patterns.
 * Prevents indexing of accidental binary files or API credentials.
 */
export function isContentSafe(content: string): { safe: boolean; reason?: string } {
  if (!content) {
    return { safe: true };
  }

  // 1. Binary check: files containing null bytes \0 are binary
  if (content.includes('\0')) {
    return { safe: false, reason: 'File content contains null bytes (binary content).' };
  }

  // 2. Secret check: prevent indexing high-entropy credentials or private keys
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return {
        safe: false,
        reason: 'File content appears to contain private keys or API credentials.',
      };
    }
  }

  return { safe: true };
}

/**
 * Detects programming language based on file extension for code highlighting and citation metadata.
 */
export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyw':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.c':
    case '.h':
      return 'c';
    case '.cpp':
    case '.hpp':
    case '.cc':
    case '.cxx':
      return 'cpp';
    case '.cs':
      return 'csharp';
    case '.rb':
      return 'ruby';
    case '.php':
      return 'php';
    case '.swift':
      return 'swift';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.scala':
      return 'scala';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell';
    case '.sql':
      return 'sql';
    case '.html':
    case '.htm':
      return 'html';
    case '.css':
    case '.scss':
    case '.sass':
    case '.less':
      return 'css';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.toml':
      return 'toml';
    case '.xml':
      return 'xml';
    case '.dockerfile':
      return 'dockerfile';
    default:
      if (path.basename(filePath).toLowerCase() === 'dockerfile') {
        return 'dockerfile';
      }
      return 'text';
  }
}
