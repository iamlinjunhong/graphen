import type { ChatMessage, ChatSession } from "./chat.js";
import type { Document } from "./document.js";
import type { GraphEdge, GraphNode } from "./graph.js";

export interface ApiErrorResponse {
  error: string;
  details?: unknown;
}

export interface ApiSuccessResponse<T> {
  data: T;
}

export interface UploadDocumentResponse {
  message: string;
  documentId: string;
  file: {
    originalName: string;
    mimeType: string;
    size: number;
  };
}

export interface ListDocumentsResponse {
  documents: Document[];
}

export interface GetDocumentResponse {
  document: Document;
}

export interface DocumentStatusResponse {
  id: string;
  status: Document["status"] | "pending";
}

export interface ReparseDocumentResponse {
  message: string;
  id: string;
}

export interface GraphOverviewResponse {
  nodeCount: number;
  edgeCount: number;
  nodeTypeDistribution: Record<string, number>;
  edgeTypeDistribution: Record<string, number>;
}

export interface GraphNodesResponse {
  nodes: GraphNode[];
}

export interface GraphNodeResponse {
  node: GraphNode;
}

export interface GraphSubgraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphSearchResponse {
  query: string;
  results: GraphNode[];
}

export interface GraphVectorSearchRequest {
  vector: number[];
  k: number;
}

export interface GraphVectorSearchResponse {
  results: Array<{
    node: GraphNode;
    score: number;
  }>;
}

export interface CreateChatSessionRequest {
  title?: string;
}

export interface CreateChatSessionResponse {
  session: ChatSession;
}

export interface ListChatSessionsResponse {
  sessions: ChatSession[];
}

export interface ChatSessionDetailResponse {
  session: ChatSession & {
    messages: ChatMessage[];
  };
}

export interface CreateChatMessageRequest {
  content: string;
  model?: string;
}

export interface CreateChatMessageResponse {
  sessionId: string;
  message: {
    content: string;
  };
}

export interface GetConfigResponse {
  config: {
    nodeEnv: string;
    corsOrigin: string;
    maxUploadSize: number;
    rateLimitWindowMs: number;
    rateLimitMax: number;
    logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  };
}

export interface UpdateConfigRequest {
  corsOrigin?: string;
  maxUploadSize?: number;
  rateLimitMax?: number;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export interface UpdateConfigResponse {
  message: string;
  requested: UpdateConfigRequest;
}

export interface ConfigModelsResponse {
  models: {
    chat: string[];
    embedding: string[];
  };
}

export interface TestConnectionResponse {
  neo4j: "ok" | "failed" | "not_configured";
  llm: "ok" | "failed" | "not_configured";
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSec?: number;
  checks?: {
    neo4j: "ok" | "failed" | "not_configured";
    llm: "ok" | "failed" | "not_configured";
  };
  memoryUsage?: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
}

export interface GraphQualityReport {
  ghostNodes: number;
  isolatedNodes: number;
  lowConfidenceNodes: number;
  suspectedDuplicates: number;
  totalNodes: number;
  totalEdges: number;
}

export interface GraphQualityResponse {
  report: GraphQualityReport;
}

export interface GraphExportResponse {
  format: "jsonld" | "cypher";
  data: string;
}

