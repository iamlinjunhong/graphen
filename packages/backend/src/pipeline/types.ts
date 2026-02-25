import type { Document, DocumentChunk, GraphEdge, GraphNode } from "@graphen/shared";
import type { ExtractionResult } from "../services/llmTypes.js";

export type PipelinePhase =
  | "parsing"
  | "chunking"
  | "extracting"
  | "resolving"
  | "embedding"
  | "saving"
  | "completed"
  | "error";

export interface PipelineStatusEvent {
  documentId: string;
  phase: PipelinePhase;
  progress: number;
  message?: string;
}

export interface ChunkExtractionResult {
  chunkId: string;
  chunkIndex: number;
  result: ExtractionResult;
}

export interface ResolvedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface DocumentPipelineOptions {
  cacheDir: string;
  chunkSize: number;
  chunkOverlap: number;
  maxChunksPerDocument: number;
  maxEstimatedTokens: number;
  extractionConcurrency: number;
  embeddingConcurrency: number;
}

export interface DocumentPipelineResult {
  document: Document;
  chunks: DocumentChunk[];
  resolvedGraph: ResolvedGraph;
  estimatedTokens: number;
}
