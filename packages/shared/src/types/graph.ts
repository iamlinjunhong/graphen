export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string;
  properties: Record<string, unknown>;
  embedding?: number[];
  sourceDocumentIds: string[];
  sourceChunkIds: string[];
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: string;
  description: string;
  properties: Record<string, unknown>;
  weight: number;
  sourceDocumentIds: string[];
  confidence: number;
  createdAt: Date;
}
