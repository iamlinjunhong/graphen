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

/**
 * Attempt to recover a UTF-8 filename that was decoded as latin1 by multer.
 * If the string contains typical latin1-mojibake byte patterns we re-encode
 * it back to a Buffer using latin1 and then decode as utf-8.
 */
/**
 * Attempt to recover a UTF-8 filename that was decoded as latin1 by multer.
 *
 * Multer decodes multipart filenames using latin1, so UTF-8 bytes get
 * misinterpreted as latin1 code points (all in 0x00–0xFF range).
 * If every character is within the latin1 range AND re-encoding as latin1
 * then decoding as UTF-8 produces a valid shorter string, we use that.
 *
 * If the string already contains characters above U+00FF (e.g. CJK),
 * it's already proper Unicode and we leave it alone.
 */
function recoverUtf8Filename(name: string): string {
  // If any character is above the latin1 range, the string is already
  // properly decoded Unicode — no recovery needed.
  const isAllLatin1 = [...name].every((c) => c.codePointAt(0)! <= 0xff);
  if (!isAllLatin1) {
    return name;
  }

  try {
    const buf = Buffer.from(name, "latin1");
    const decoded = buf.toString("utf8");
    // Valid UTF-8 recovery produces a shorter string (multi-byte sequences
    // collapse) and contains no replacement character U+FFFD.
    if (!decoded.includes("\uFFFD") && decoded.length < name.length) {
      return decoded;
    }
  } catch {
    // fall through – keep original
  }
  return name;
}

export function sanitizeFilename(filename: string): string {
  const recovered = recoverUtf8Filename(basename(filename));
  const cleanBase = recovered.replace(/[^\p{L}\p{N}_.-]/gu, "_");
  return cleanBase.length > 0 ? cleanBase : "file";
}
