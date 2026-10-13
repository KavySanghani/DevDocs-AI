export interface ParsedPage {
  pageNumber: number;
  text: string;
  characterCount: number;
}

export interface ParsedSection {
  title: string;
  level: number;
  content: string;
  lineStart: number;
  lineEnd: number;
}

export interface ParseResult {
  sourceType: 'pdf' | 'markdown' | 'text';
  rawText: string;
  characterCount: number;
  wordCount: number;
  pageCount?: number;
  pages?: ParsedPage[];
  sections?: ParsedSection[];
  metadata?: Record<string, unknown>;
}

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'PARSE_ERROR',
    public readonly statusCode: number = 422
  ) {
    super(message);
    this.name = 'ParseError';
  }
}
