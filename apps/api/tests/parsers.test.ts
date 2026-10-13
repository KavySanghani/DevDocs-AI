import { describe, it, expect } from 'vitest';
import { parseText } from '../src/services/parsers/textParser.js';
import { parseMarkdown } from '../src/services/parsers/markdownParser.js';
import { parsePdf } from '../src/services/parsers/pdfParser.js';
import { ParseError } from '../src/services/parsers/types.js';
import {
  computeContentHash,
  sanitizeFilename,
  validateDocumentFile,
  ValidationError,
} from '../src/services/documentValidation.js';

describe('Document Parsers & Validation Unit Tests', () => {
  describe('1. Text Parser', () => {
    it('parses plain text and preserves line breaks and structure', () => {
      const text = 'Line 1: System Architecture\n\nLine 3: Database Config\nLine 4: End';
      const result = parseText(Buffer.from(text));

      expect(result.sourceType).toBe('text');
      expect(result.characterCount).toBe(text.length);
      expect(result.wordCount).toBe(11);
      expect(result.rawText).toBe(text);
      expect(result.metadata?.lineCount).toBe(4);
    });

    it('rejects empty or whitespace-only text files with ParseError', () => {
      expect(() => parseText(Buffer.from('   \n\n\t  '))).toThrow(ParseError);
      expect(() => parseText(Buffer.from(''))).toThrowError(/no readable text content/);
    });
  });

  describe('2. Markdown Parser', () => {
    it('preserves section headings, code blocks, and line ranges', () => {
      const md = [
        '# DevDocs Architecture',
        'Overview of the system.',
        '',
        '## Database Layer',
        'PostgreSQL with pgvector.',
        '```typescript',
        '# Not a heading because inside code fence',
        'const db = "pg";',
        '```',
        '',
        '### Retrieval Module',
        'Hybrid search with RRF.',
      ].join('\n');

      const result = parseMarkdown(Buffer.from(md));

      expect(result.sourceType).toBe('markdown');
      expect(result.sections).toBeDefined();
      expect(result.sections!.length).toBe(3);

      // Section 1: H1
      expect(result.sections![0]!.title).toBe('DevDocs Architecture');
      expect(result.sections![0]!.level).toBe(1);
      expect(result.sections![0]!.lineStart).toBe(1);

      // Section 2: H2 (containing code block)
      expect(result.sections![1]!.title).toBe('Database Layer');
      expect(result.sections![1]!.level).toBe(2);
      expect(result.sections![1]!.content).toContain('const db = "pg";');
      expect(result.sections![1]!.content).toContain('# Not a heading because inside code fence');

      // Section 3: H3
      expect(result.sections![2]!.title).toBe('Retrieval Module');
      expect(result.sections![2]!.level).toBe(3);
    });

    it('creates a fallback section for markdown without headings', () => {
      const md = 'Just a paragraph without any headings.\nSecond line.';
      const result = parseMarkdown(Buffer.from(md));

      expect(result.sections?.length).toBe(1);
      expect(result.sections![0]!.title).toBe('Overview');
      expect(result.sections![0]!.content).toBe(md);
    });

    it('rejects empty markdown files', () => {
      expect(() => parseMarkdown(Buffer.from(''))).toThrow(ParseError);
    });
  });

  describe('3. PDF Parser', () => {
    // Generate valid 1-page PDF
    const createPdfWithText = (text: string) => {
      const escaped = text.replace(/([()\\])/g, '\\$1');
      const stream = `BT /F1 12 Tf 72 712 Td (${escaped}) Tj ET`;
      const streamLen = stream.length;
      return [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
        `3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj`,
        `4 0 obj<</Length ${streamLen}>>stream`,
        stream,
        'endstream',
        'endobj',
        'xref',
        '0 5',
        '0000000000 65535 f ',
        '0000000010 00000 n ',
        '0000000053 00000 n ',
        '0000000102 00000 n ',
        '0000000210 00000 n ',
        'trailer<</Size 5/Root 1 0 R>>',
        'startxref',
        '300',
        '%%EOF',
      ].join('\n');
    };

    it('rejects invalid PDF magic bytes', async () => {
      const notAPdf = Buffer.from('This is a text file renamed to .pdf');
      await expect(parsePdf(notAPdf)).rejects.toThrow(ParseError);
      await expect(parsePdf(notAPdf)).rejects.toThrow(/Invalid PDF file signature/);
    });

    it('rejects scanned / textless PDFs with actionable OCR message', async () => {
      // Valid PDF structure with 0 text stream
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

      await expect(parsePdf(Buffer.from(blankPdf))).rejects.toThrow(ParseError);
      await expect(parsePdf(Buffer.from(blankPdf))).rejects.toThrow(/Scanned or image-only documents require OCR/);
    });

    it('rejects corrupted / malformed PDF', async () => {
      const malformedPdf = Buffer.from('%PDF-1.4\nCorrupted binary junk that is definitely not valid PDF syntax!');
      await expect(parsePdf(malformedPdf)).rejects.toThrow(ParseError);
    });
  });

  describe('4. Document Validation & Sanitization', () => {
    it('sanitizes dangerous filenames and prevents path traversal', () => {
      expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
      expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
      expect(sanitizeFilename('.env')).toBe('file_.env');
      expect(sanitizeFilename('My Architecture Document (v2).md')).toBe('My Architecture Document (v2).md');
    });

    it('computes stable SHA-256 hash for identical bytes', () => {
      const buf1 = Buffer.from('Engineering System Specifications 2026');
      const buf2 = Buffer.from('Engineering System Specifications 2026');
      const buf3 = Buffer.from('Different Content');

      expect(computeContentHash(buf1)).toBe(computeContentHash(buf2));
      expect(computeContentHash(buf1)).not.toBe(computeContentHash(buf3));
    });

    it('rejects empty file (0 bytes)', () => {
      expect(() => validateDocumentFile('doc.txt', Buffer.alloc(0))).toThrow(ValidationError);
      expect(() => validateDocumentFile('doc.txt', Buffer.alloc(0))).toThrow(/empty/);
    });

    it('rejects oversized file', () => {
      const bigBuf = Buffer.alloc(11 * 1024 * 1024); // 11MB
      expect(() => validateDocumentFile('big.txt', bigBuf, 'text/plain', 10 * 1024 * 1024)).toThrow(ValidationError);
      expect(() => validateDocumentFile('big.txt', bigBuf, 'text/plain', 10 * 1024 * 1024)).toThrow(/exceeds/);
    });

    it('rejects unsupported file extension', () => {
      const buf = Buffer.from('malicious payload');
      expect(() => validateDocumentFile('script.sh', buf)).toThrow(ValidationError);
      expect(() => validateDocumentFile('app.exe', buf)).toThrow(/Unsupported file extension/);
    });

    it('rejects binary file disguised as text (null byte detection)', () => {
      const fakeText = Buffer.concat([Buffer.from('Normal text'), Buffer.from([0x00, 0x01, 0x02])]);
      expect(() => validateDocumentFile('fake.txt', fakeText, 'text/plain')).toThrow(ValidationError);
      expect(() => validateDocumentFile('fake.txt', fakeText, 'text/plain')).toThrow(/Suspicious binary content/);
    });

    it('rejects fake PDF with non-PDF header', () => {
      const fakePdf = Buffer.from('PNG_IMAGE_DATA_NOT_PDF');
      expect(() => validateDocumentFile('fake.pdf', fakePdf, 'application/pdf')).toThrow(ValidationError);
      expect(() => validateDocumentFile('fake.pdf', fakePdf, 'application/pdf')).toThrow(/Invalid PDF file signature/);
    });
  });
});
