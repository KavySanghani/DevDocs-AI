import crypto from 'node:crypto';
import path from 'node:path';
import type { DocumentSourceType } from '@devdocs/shared';

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'VALIDATION_ERROR',
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface ValidatedFile {
  filename: string;
  sourceType: DocumentSourceType;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  buffer: Buffer;
}

const ALLOWED_EXTENSIONS: Record<string, DocumentSourceType> = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
};

const ALLOWED_MIME_TYPES: Record<string, DocumentSourceType[]> = {
  'application/pdf': ['pdf'],
  'text/markdown': ['markdown'],
  'text/x-markdown': ['markdown'],
  'text/plain': ['text', 'markdown'],
  'application/octet-stream': ['markdown', 'text', 'pdf'], // Often set by browser/curl
};

const PDF_MAGIC_BYTES = Buffer.from('%PDF-');

/**
 * Sanitizes an uploaded filename to prevent directory traversal,
 * control character injection, and excessively long names.
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    return 'document.txt';
  }

  // Normalize windows backslashes to forward slashes first so basename works on all platforms
  const normalizedSeparators = filename.replace(/\\/g, '/');

  // Strip path traversal sequences, null bytes, and absolute paths
  let clean = path.basename(normalizedSeparators).replace(/[\0\r\n\t]/g, '');

  // Strip hazardous characters while allowing unicode letters, numbers, hyphens, dots, underscores, spaces, parentheses
  clean = clean.replace(/[^a-zA-Z0-9.\-_ ()]/g, '_').trim();

  // Prevent hidden files (e.g. .env, .git)
  if (clean.startsWith('.')) {
    clean = `file_${clean}`;
  }

  // Ensure length does not exceed 255 characters
  if (clean.length > 255) {
    const ext = path.extname(clean);
    const base = clean.slice(0, 255 - ext.length);
    clean = `${base}${ext}`;
  }

  return clean || 'document.txt';
}

/**
 * Computes a deterministic SHA-256 hash of a file's byte buffer.
 */
export function computeContentHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Validates file size, extension, MIME type, and content signatures.
 */
export function validateDocumentFile(
  filename: string,
  buffer: Buffer,
  declaredMimeType?: string,
  maxSizeBytes: number = 10 * 1024 * 1024
): ValidatedFile {
  const sanitizedName = sanitizeFilename(filename);

  // 1. Size Validation
  if (!buffer || buffer.length === 0) {
    throw new ValidationError(
      'Uploaded file is empty (0 bytes).',
      'EMPTY_FILE',
      400
    );
  }

  if (buffer.length > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    throw new ValidationError(
      `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of ${maxMb} MB.`,
      'FILE_TOO_LARGE',
      413
    );
  }

  // 2. Extension Validation
  const ext = path.extname(sanitizedName).toLowerCase();
  const sourceType = ALLOWED_EXTENSIONS[ext];
  if (!sourceType) {
    throw new ValidationError(
      `Unsupported file extension "${ext}". Supported formats are: .pdf, .md, .markdown, .txt`,
      'UNSUPPORTED_FILE_TYPE',
      400
    );
  }

  // 3. MIME Type Validation (if provided)
  const mime = declaredMimeType?.toLowerCase().trim() || 'application/octet-stream';
  const allowedForMime = ALLOWED_MIME_TYPES[mime];
  if (allowedForMime && !allowedForMime.includes(sourceType)) {
    throw new ValidationError(
      `Declared MIME type "${mime}" is incompatible with file extension "${ext}".`,
      'INVALID_MIME_TYPE',
      400
    );
  }

  // 4. Magic Bytes & Binary Signature Validation
  if (sourceType === 'pdf') {
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES)) {
      throw new ValidationError(
        'Invalid PDF file signature. The file does not start with the required %PDF- header.',
        'INVALID_FILE_SIGNATURE',
        400
      );
    }
  } else {
    // For text and markdown: verify it is valid text and does not contain null bytes (binary payload indicator)
    const inspectionLength = Math.min(buffer.length, 8192);
    for (let i = 0; i < inspectionLength; i++) {
      if (buffer[i] === 0) {
        throw new ValidationError(
          'Suspicious binary content detected in text document (null byte).',
          'SUSPICIOUS_BINARY_CONTENT',
          400
        );
      }
    }
  }

  const contentHash = computeContentHash(buffer);

  return {
    filename: sanitizedName,
    sourceType,
    mimeType: mime,
    sizeBytes: buffer.length,
    contentHash,
    buffer,
  };
}
