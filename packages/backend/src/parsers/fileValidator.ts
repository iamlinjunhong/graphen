import { basename, extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";

export type SupportedFileType = "pdf" | "md" | "txt";

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface FileValidationOptions {
  maxSizeBytes?: number;
}

export interface ValidatedFile {
  fileType: SupportedFileType;
  sanitizedFilename: string;
  mimeType: string;
  size: number;
}

const extensionToType: Record<string, SupportedFileType> = {
  ".pdf": "pdf",
  ".md": "md",
  ".txt": "txt"
};

const allowedMimeTypes: Record<SupportedFileType, string[]> = {
  pdf: ["application/pdf"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
  txt: ["text/plain"]
};

const extensionFallbackMime: Record<SupportedFileType, string> = {
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain"
};

export async function validateUploadedFile(
  file: UploadedFileLike,
  options: FileValidationOptions = {}
): Promise<ValidatedFile> {
  const extension = extname(file.originalname).toLowerCase();
  const fileType = extensionToType[extension];
  if (!fileType) {
    throw new Error("Unsupported file extension. Only .pdf, .md, .txt are allowed.");
  }

  if (options.maxSizeBytes !== undefined && file.size > options.maxSizeBytes) {
    throw new Error(`File is too large. Maximum size is ${options.maxSizeBytes} bytes.`);
  }

  const allowed = allowedMimeTypes[fileType];
  const declaredMime = (file.mimetype || "").toLowerCase();
  const detected = await fileTypeFromBuffer(file.buffer);
  const detectedMime = detected?.mime.toLowerCase();

  // Browsers often send application/octet-stream for text-based files (.md, .txt).
  // Treat it as unknown and fall back to extension-based detection instead of rejecting.
  const effectiveDeclaredMime =
    declaredMime === "application/octet-stream" ? "" : declaredMime;

  if (effectiveDeclaredMime && !allowed.includes(effectiveDeclaredMime)) {
    throw new Error(`MIME type mismatch for ${extension}. Received ${declaredMime}.`);
  }

  if (detectedMime && !allowed.includes(detectedMime)) {
    throw new Error(`Binary signature mismatch for ${extension}. Detected ${detectedMime}.`);
  }

  if (!declaredMime && !detectedMime) {
    throw new Error("Unable to determine file MIME type.");
  }

  return {
    fileType,
    sanitizedFilename: sanitizeFilename(file.originalname),
    mimeType: detectedMime ?? declaredMime ?? extensionFallbackMime[fileType],
    size: file.size
  };
}

export function sanitizeFilename(filename: string): string {
  const cleanBase = basename(filename).replace(/[^\w.-]/g, "_");
  return cleanBase.length > 0 ? cleanBase : "file";
}
