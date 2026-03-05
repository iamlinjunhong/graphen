import { createHash } from "node:crypto";
import type { MemorySourceType } from "@graphen/shared";

interface BuildMemoryEvidenceHashInput {
  sourceType: MemorySourceType;
  documentId?: string | null;
  chunkId?: string | null;
  chatSessionId?: string | null;
  chatMessageId?: string | null;
  excerpt?: string | null;
}

function normalizeNullableText(value?: string | null): string {
  return (value ?? "").trim();
}

function normalizeExcerpt(value?: string | null): string {
  return normalizeNullableText(value).replace(/\s+/g, " ");
}

export function buildMemoryEvidenceHash(input: BuildMemoryEvidenceHashInput): string {
  const payload = [
    input.sourceType,
    normalizeNullableText(input.documentId),
    normalizeNullableText(input.chunkId),
    normalizeNullableText(input.chatSessionId),
    normalizeNullableText(input.chatMessageId),
    normalizeExcerpt(input.excerpt)
  ].join("|");

  return createHash("sha256").update(payload).digest("hex");
}

