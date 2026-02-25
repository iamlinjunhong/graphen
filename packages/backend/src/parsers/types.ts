export interface ParsedDocumentResult {
  text: string;
  metadata: {
    pageCount?: number;
    wordCount: number;
    lineCount?: number;
  };
}

export interface DocumentParser {
  parse(buffer: Buffer): Promise<ParsedDocumentResult>;
}

export function countWords(input: string): number {
  const normalized = input.trim();
  if (normalized.length === 0) {
    return 0;
  }

  return normalized.split(/\s+/).length;
}
