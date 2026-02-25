import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileTypeFromBuffer } from "file-type";
import {
  sanitizeFilename,
  validateUploadedFile,
  type UploadedFileLike
} from "../../../src/parsers/fileValidator.js";

vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi.fn()
}));

const mockedFileTypeFromBuffer = vi.mocked(fileTypeFromBuffer);

function buildFile(overrides: Partial<UploadedFileLike> = {}): UploadedFileLike {
  return {
    originalname: "demo.pdf",
    mimetype: "application/pdf",
    size: 128,
    buffer: Buffer.from("%PDF-1.7"),
    ...overrides
  };
}

describe("fileValidator", () => {
  beforeEach(() => {
    mockedFileTypeFromBuffer.mockReset();
  });

  it("accepts valid extension + mime for PDF", async () => {
    mockedFileTypeFromBuffer.mockResolvedValue({
      ext: "pdf",
      mime: "application/pdf"
    });

    const result = await validateUploadedFile(buildFile());

    expect(result.fileType).toBe("pdf");
    expect(result.mimeType).toBe("application/pdf");
  });

  it("rejects unsupported extension", async () => {
    mockedFileTypeFromBuffer.mockResolvedValue(undefined);

    await expect(
      validateUploadedFile(
        buildFile({
          originalname: "evil.exe",
          mimetype: "application/octet-stream"
        })
      )
    ).rejects.toThrow("Unsupported file extension");
  });

  it("rejects mismatched declared mime", async () => {
    mockedFileTypeFromBuffer.mockResolvedValue({
      ext: "pdf",
      mime: "application/pdf"
    });

    await expect(
      validateUploadedFile(
        buildFile({
          originalname: "notes.md",
          mimetype: "application/pdf"
        })
      )
    ).rejects.toThrow("MIME type mismatch");
  });

  it("rejects file larger than max size", async () => {
    mockedFileTypeFromBuffer.mockResolvedValue(undefined);

    await expect(
      validateUploadedFile(
        buildFile({
          originalname: "notes.txt",
          mimetype: "text/plain",
          size: 1024
        }),
        { maxSizeBytes: 100 }
      )
    ).rejects.toThrow("File is too large");
  });

  it("sanitizes risky filename", () => {
    expect(sanitizeFilename("../weird name?.md")).toBe("weird_name_.md");
  });
});
