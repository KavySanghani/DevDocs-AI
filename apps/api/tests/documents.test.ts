import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, query } from '@devdocs/db';
import { resetTestDatabase } from '@devdocs/db/migrator';
import { validateTestResetSafety } from '@devdocs/db/safety';
import { buildApp } from '../src/app.js';
import { validateEnv } from '../src/config/env.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://localhost:5433/devdocs_ai_test';

validateTestResetSafety(TEST_DATABASE_URL, process.env.DATABASE_URL);

/**
 * Helper to construct multipart/form-data payloads with binary support.
 */
function createMultipartPayload(
  fields: Record<string, string>,
  file?: { fieldName: string; filename: string; contentType: string; content: Buffer | string }
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      )
    );
  }

  if (file) {
    const fileBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      )
    );
    chunks.push(fileBuf);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

// Minimal valid PDF with 1 page of extractable text
function createValidPdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const stream = `BT\n/F1 12 Tf\n100 700 Td\n(${escaped}) Tj\nET\n`;
  const streamLen = Buffer.byteLength(stream);
  const pdfString = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${streamLen}>>stream`,
    stream,
    'endstream',
    'endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'xref',
    '0 6',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000052 00000 n ',
    '0000000101 00000 n ',
    '0000000216 00000 n ',
    '0000000321 00000 n ',
    'trailer<</Size 6/Root 1 0 R>>',
    'startxref',
    '386',
    '%%EOF',
  ].join('\n');
  return Buffer.from(pdfString);
}

// Blank PDF with zero text streams (simulates scanned image PDF)
function createBlankPdf(): Buffer {
  const blankPdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R/Resources<<>>>>endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000010 00000 n ',
    '0000000053 00000 n ',
    '0000000102 00000 n ',
    'trailer<</Size 4/Root 1 0 R>>',
    'startxref',
    '178',
    '%%EOF',
  ].join('\n');
  return Buffer.from(blankPdf);
}

describe('Document Upload, Validation, Parsing, and Lifecycle API', () => {
  let app: FastifyInstance;
  const testSecret = 'test_jwt_secret_for_documents_suite_32_characters!';

  let orgAId: string;
  let orgBId: string;

  let adminAToken: string;
  let memberAToken: string;
  let viewerAToken: string;
  let adminBToken: string;

  let uploadedTextDocId: string;
  let uploadedMdDocId: string;

  beforeAll(async () => {
    // Fresh test schema on dedicated test database
    await resetTestDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = testSecret;

    const testEnv = validateEnv({
      PORT: '4005',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: testSecret,
      MAX_FILE_SIZE_BYTES: '10485760',
    });

    app = await buildApp({ env: testEnv });
    await app.ready();

    // Register users
    async function register(email: string) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, password: 'SecurePassword123!' },
      });
      const body = JSON.parse(res.body);
      return { token: body.token as string, userId: body.user.id as string };
    }

    const adminA = await register('admin_a@corp.com');
    adminAToken = adminA.token;

    const memberA = await register('member_a@corp.com');
    memberAToken = memberA.token;

    const viewerA = await register('viewer_a@corp.com');
    viewerAToken = viewerA.token;

    const adminB = await register('admin_b@othercorp.com');
    adminBToken = adminB.token;

    // Create Organization A (creator is Admin)
    const orgARes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { name: 'Acme Cloud Platform', slug: 'acme-cloud' },
    });
    orgAId = JSON.parse(orgARes.body).organization.id;

    // Add Member and Viewer to Org A
    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'member_a@corp.com', role: 'member' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { email: 'viewer_a@corp.com', role: 'viewer' },
    });

    // Create Organization B (foreign organization)
    const orgBRes = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { authorization: `Bearer ${adminBToken}` },
      payload: { name: 'Beta Systems', slug: 'beta-systems' },
    });
    orgBId = JSON.parse(orgBRes.body).organization.id;
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('1. Supported Document Uploads & Parsing', () => {
    it('successfully uploads and parses a plain-text (.txt) document', async () => {
      const textContent = 'DevDocs AI Architecture Specifications.\nLine 2: Postgres pgvector.';
      const multipart = createMultipartPayload(
        { organizationId: orgAId, name: 'Architecture Specs' },
        { fieldName: 'file', filename: 'architecture.txt', contentType: 'text/plain', content: textContent }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      expect(body.document).toBeDefined();
      expect(body.document.name).toBe('Architecture Specs');
      expect(body.document.sourceType).toBe('text');
      expect(body.document.status).toBe('ready');
      expect(body.document.currentVersion).toBeDefined();
      expect(body.document.currentVersion.versionNumber).toBe(1);
      expect(body.document.currentVersion.status).toBe('ready');
      expect(body.document.currentVersion.contentHash).toBeDefined();

      uploadedTextDocId = body.document.id;

      // Direct PostgreSQL query verification: verify rawText is persisted in source_details JSONB
      const versionDbRes = await query<{
        status: string;
        source_details: {
          rawText?: string;
          characterCount?: number;
          wordCount?: number;
          originalFilename?: string;
        };
      }>(
        'SELECT status, source_details FROM document_versions WHERE document_id = $1',
        [body.document.id]
      );
      expect(versionDbRes.rows.length).toBe(1);
      const versionRow = versionDbRes.rows[0]!;
      expect(versionRow.status).toBe('ready');
      expect(versionRow.source_details.rawText).toBe(textContent);
      expect(versionRow.source_details.characterCount).toBe(textContent.length);
      expect(versionRow.source_details.originalFilename).toBe('architecture.txt');
    });

    it('successfully uploads and parses a Markdown (.md) document preserving sections', async () => {
      const mdContent = [
        '# Engineering Guide',
        'Introduction paragraph.',
        '',
        '## Database Config',
        'PostgreSQL with pgvector.',
        '```typescript',
        'const vectorSize = 1536;',
        '```',
      ].join('\n');

      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'guide.md', contentType: 'text/markdown', content: mdContent }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      expect(body.document.name).toBe('guide.md');
      expect(body.document.sourceType).toBe('markdown');
      expect(body.document.status).toBe('ready');

      uploadedMdDocId = body.document.id;

      // Direct PostgreSQL query verification: verify sections and rawText in source_details
      const mdVersionDbRes = await query<{
        status: string;
        source_details: {
          rawText?: string;
          sections?: Array<{ title: string; level: number; content: string }>;
        };
      }>(
        'SELECT status, source_details FROM document_versions WHERE document_id = $1',
        [body.document.id]
      );
      expect(mdVersionDbRes.rows.length).toBe(1);
      const mdVersionRow = mdVersionDbRes.rows[0]!;
      expect(mdVersionRow.status).toBe('ready');
      expect(mdVersionRow.source_details.rawText).toBe(mdContent);
      expect(mdVersionRow.source_details.sections).toBeDefined();
      expect(mdVersionRow.source_details.sections!.length).toBe(2);
      expect(mdVersionRow.source_details.sections![0]!.title).toBe('Engineering Guide');
    });

    it('successfully uploads and parses a PDF document', async () => {
      const pdfBuffer = createValidPdf('DevDocs AI Cloud Ingestion Engine');
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'engine_specs.pdf', contentType: 'application/pdf', content: pdfBuffer }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      expect(body.document.sourceType).toBe('pdf');
      expect(body.document.status).toBe('ready');

      // Direct PostgreSQL query verification: verify pages, rawText, and pageCount in source_details
      const pdfVersionDbRes = await query<{
        status: string;
        source_details: {
          rawText?: string;
          pageCount?: number;
          pages?: Array<{ pageNumber: number; text: string }>;
        };
      }>(
        'SELECT status, source_details FROM document_versions WHERE document_id = $1',
        [body.document.id]
      );
      expect(pdfVersionDbRes.rows.length).toBe(1);
      const pdfVersionRow = pdfVersionDbRes.rows[0]!;
      expect(pdfVersionRow.status).toBe('ready');
      expect(pdfVersionRow.source_details.pageCount).toBe(1);
      expect(pdfVersionRow.source_details.pages).toBeDefined();
      expect(pdfVersionRow.source_details.pages![0]!.text).toContain('DevDocs AI Cloud Ingestion Engine');
      expect(pdfVersionRow.source_details.rawText).toContain('DevDocs AI Cloud Ingestion Engine');
    });

    it('rejects duplicate content upload with 409 Conflict', async () => {
      const textContent = 'DevDocs AI Architecture Specifications.\nLine 2: Postgres pgvector.';
      const multipart = createMultipartPayload(
        { organizationId: orgAId, name: 'Duplicate Upload Attempt' },
        { fieldName: 'file', filename: 'arch_copy.txt', contentType: 'text/plain', content: textContent }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DUPLICATE_DOCUMENT');
      expect(body.error.details).toBeDefined();
      expect(body.error.details.existingDocumentId).toBe(uploadedTextDocId);
    });
  });

  describe('2. Validation & Malicious Input Rejection', () => {
    it('rejects empty file (0 bytes) with 400 EMPTY_FILE', async () => {
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'empty.txt', contentType: 'text/plain', content: Buffer.alloc(0) }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('EMPTY_FILE');
    });

    it('rejects unsupported file extension (.exe) with 400 UNSUPPORTED_FILE_TYPE', async () => {
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'malware.exe', contentType: 'application/octet-stream', content: 'fake-exe' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    });

    it('rejects binary file disguised as text with 400 SUSPICIOUS_BINARY_CONTENT', async () => {
      const fakeText = Buffer.concat([Buffer.from('Safe preamble'), Buffer.from([0x00, 0x01, 0x02, 0xff])]);
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'disguised.txt', contentType: 'text/plain', content: fakeText }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('SUSPICIOUS_BINARY_CONTENT');
    });

    it('rejects fake PDF with non-PDF header with 400 INVALID_FILE_SIGNATURE', async () => {
      const fakePdf = Buffer.from('NOT_A_PDF_STREAM_HEADER');
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'fake.pdf', contentType: 'application/pdf', content: fakePdf }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('INVALID_FILE_SIGNATURE');
    });

    it('marks scanned / image-only PDF as FAILED with actionable OCR message', async () => {
      const blankPdf = createBlankPdf();
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'scanned_manual.pdf', contentType: 'application/pdf', content: blankPdf }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${memberAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      expect(body.document.status).toBe('failed');
      expect(body.document.currentVersion.status).toBe('failed');
      expect(body.document.currentVersion.errorMessage).toMatch(/Scanned or image-only documents require OCR/);
    });
  });

  describe('3. Document Listing, Pagination & Details', () => {
    it('lists documents scoped strictly to Organization A', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents?organizationId=${orgAId}`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.documents).toBeDefined();
      expect(Array.isArray(body.documents)).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(body.documents.every((d: { organizationId: string }) => d.organizationId === orgAId)).toBe(true);
    });

    it('supports pagination parameters (limit and page)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents?organizationId=${orgAId}&page=1&limit=1`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.documents.length).toBe(1);
      expect(body.limit).toBe(1);
      expect(body.page).toBe(1);
    });

    it('retrieves detailed document metadata and version status by ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${uploadedTextDocId}`,
        headers: {
          authorization: `Bearer ${viewerAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.document).toBeDefined();
      expect(body.document.id).toBe(uploadedTextDocId);
      expect(body.document.status).toBe('ready');
      expect(body.document.sourceDetails).toBeDefined();
      expect(body.document.sourceDetails.fileSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('4. RBAC Permission Matrix on Documents', () => {
    it('Viewer is FORBIDDEN from uploading documents (403)', async () => {
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'viewer_attempt.txt', contentType: 'text/plain', content: 'Viewer text' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${viewerAToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Viewer is FORBIDDEN from deleting documents (403)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${uploadedMdDocId}`,
        headers: {
          authorization: `Bearer ${viewerAToken}`,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Member is FORBIDDEN from deleting documents (403)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${uploadedMdDocId}`,
        headers: {
          authorization: `Bearer ${memberAToken}`,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Admin CAN delete documents (200)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${uploadedMdDocId}`,
        headers: {
          authorization: `Bearer ${adminAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      // Verify document no longer exists
      const checkRes = await app.inject({
        method: 'GET',
        url: `/api/documents/${uploadedMdDocId}`,
        headers: {
          authorization: `Bearer ${adminAToken}`,
        },
      });
      expect(checkRes.statusCode).toBe(404);
    });
  });

  describe('5. Tenant Isolation & Non-Disclosure', () => {
    it('Tenant B cannot retrieve Tenant A document by ID (returns 404)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${uploadedTextDocId}`,
        headers: {
          authorization: `Bearer ${adminBToken}`, // Foreign admin
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('Tenant B cannot list Tenant A documents (returns 404)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents?organizationId=${orgAId}`,
        headers: {
          authorization: `Bearer ${adminBToken}`,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('Tenant B cannot upload to Tenant A organization (returns 404)', async () => {
      const multipart = createMultipartPayload(
        { organizationId: orgAId },
        { fieldName: 'file', filename: 'infiltrate.txt', contentType: 'text/plain', content: 'Infiltration payload' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/documents',
        headers: {
          authorization: `Bearer ${adminBToken}`,
          ...multipart.headers,
        },
        payload: multipart.body,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ORGANIZATION_NOT_FOUND');
    });

    it('Tenant B cannot delete Tenant A document (returns 404)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/documents/${uploadedTextDocId}`,
        headers: {
          authorization: `Bearer ${adminBToken}`,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
    });
  });
});
