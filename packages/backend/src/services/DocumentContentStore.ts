import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DocumentFileType, GetDocumentContentResponse } from "@graphen/shared";
import { PDFParser } from "../parsers/PDFParser.js";

const MAX_EDITABLE_CHARS = 200_000;

export interface DocumentContentStoreOptions {
  uploadsDir: string;
}

interface OriginalFileInfo {
  filePath: string;
  fileType: DocumentFileType;
}

export class DocumentContentStore {
  private readonly uploadsDir: string;

  constructor(options: DocumentContentStoreOptions) {
    this.uploadsDir = options.uploadsDir;
  }

  /**
   * Get editable content for a document.
   * Priority: sidecar .editor/content.txt > lazy-create from original file.
   */
  async getContent(
    documentId: string,
    originalFile: OriginalFileInfo
  ): Promise<GetDocumentContentResponse> {
    const editorDir = resolve(this.uploadsDir, documentId, ".editor");
    const sidecarPath = resolve(editorDir, "content.txt");

    // Check if sidecar exists
    if (await this.fileExists(sidecarPath)) {
      const raw = await readFile(sidecarPath, "utf-8");
      return this.buildResponse(documentId, raw, originalFile.fileType, "edited");
    }

    // First access: construct from original file
    const content = await this.readOriginalContent(originalFile);
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Persist sidecar for future reads
    await mkdir(editorDir, { recursive: true });
    await writeFile(sidecarPath, normalized, "utf-8");

    return this.buildResponse(documentId, normalized, originalFile.fileType, "parsed");
  }

  /**
   * Write edited content to sidecar file.
   */
  async writeSidecar(documentId: string, content: string): Promise<void> {
    const editorDir = resolve(this.uploadsDir, documentId, ".editor");
    await mkdir(editorDir, { recursive: true });
    await writeFile(resolve(editorDir, "content.txt"), content, "utf-8");
  }

  private async readOriginalContent(file: OriginalFileInfo): Promise<string> {
    const buffer = await readFile(file.filePath);

    if (file.fileType === "pdf") {
      const parser = new PDFParser();
      const result = await parser.parse(buffer);
      return result.text;
    }

    // md and txt: read raw text directly (preserve markdown syntax)
    return buffer.toString("utf-8");
  }

  private buildResponse(
    documentId: string,
    content: string,
    fileType: DocumentFileType,
    contentSource: "parsed" | "edited"
  ): GetDocumentContentResponse {
    const totalCharCount = content.length;
    const truncated = totalCharCount > MAX_EDITABLE_CHARS;
    const finalContent = truncated ? content.slice(0, MAX_EDITABLE_CHARS) : content;

    return {
      documentId,
      content: finalContent,
      fileType,
      charCount: finalContent.length,
      totalCharCount,
      truncated,
      contentSource,
    };
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
