import { beforeEach, describe, expect, it, vi } from "vitest";
import pdfParse from "pdf-parse";
import { PDFParser } from "../../../src/parsers/PDFParser.js";

vi.mock("pdf-parse", () => ({
  default: vi.fn()
}));

const mockedPdfParse = vi.mocked(pdfParse);

describe("PDFParser", () => {
  beforeEach(() => {
    mockedPdfParse.mockReset();
  });

  it("uses pdf-parse output as parsed text and metadata", async () => {
    mockedPdfParse.mockResolvedValue({
      text: "Graphen parses PDF files",
      numpages: 3
    } as never);

    const parser = new PDFParser();
    const result = await parser.parse(Buffer.from("%PDF-1.7", "utf8"));

    expect(mockedPdfParse).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Graphen parses PDF files");
    expect(result.metadata.pageCount).toBe(3);
    expect(result.metadata.wordCount).toBe(4);
  });
});
