import { countWords, type DocumentParser, type ParsedDocumentResult } from "./types.js";

export class TextParser implements DocumentParser {
  async parse(buffer: Buffer): Promise<ParsedDocumentResult> {
    const text = buffer.toString("utf8");
    return {
      text,
      metadata: {
        wordCount: countWords(text),
        lineCount: text.length > 0 ? text.split(/\r?\n/).length : 0
      }
    };
  }
}
