export type DocumentFileType = "pdf" | "md" | "txt";

export type DocumentStatus =
  | "uploading"
  | "parsing"
  | "extracting"
  | "embedding"
  | "completed"
  | "error";

export interface Document {
  id: string;
  filename: string;
  fileType: DocumentFileType;
  fileSize: number;
  status: DocumentStatus;
  uploadedAt: Date;
  parsedAt?: Date;
  metadata: {
    pageCount?: number;
    wordCount?: number;
    chunkCount?: number;
    entityCount?: number;
    edgeCount?: number;
  };
  errorMessage?: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  index: number;
  embedding?: number[];
  metadata: {
    pageNumber?: number;
    startLine?: number;
    endLine?: number;
  };
}
