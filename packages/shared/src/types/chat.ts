export interface ChatSession {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatSource {
  documentId: string;
  documentName: string;
  chunkId: string;
  relevanceScore: number;
  snippet: string;
  pageNumber?: number;
}

export interface SourcePath {
  nodes: string[];
  relations: string[];
}

export interface InferredRelation {
  source: string;
  target: string;
  relationType: string;
  reasoning: string;
  confidence: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  sources?: ChatSource[];
  graphContext?: {
    nodes: string[];
    edges: string[];
  };
  sourcePaths?: SourcePath[];
  inferredRelations?: InferredRelation[];
  createdAt: Date;
}
