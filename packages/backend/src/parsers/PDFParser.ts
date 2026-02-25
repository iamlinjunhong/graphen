import pdfParse from "pdf-parse";
import { countWords, type DocumentParser, type ParsedDocumentResult } from "./types.js";

interface PdfParseResult {
  text: string;
  numpages: number;
}

export class PDFParser implements DocumentParser {
  async parse(buffer: Buffer): Promise<ParsedDocumentResult> {
    const result = (await pdfParse(buffer)) as PdfParseResult;
    const text = result.text ?? "";

    return {
      text,
      metadata: {
        pageCount: result.numpages,
        wordCount: countWords(text),
        lineCount: text.length > 0 ? text.split(/\r?\n/).length : 0
      }
    };
  }
}
