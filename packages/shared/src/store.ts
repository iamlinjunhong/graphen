import type { Document, DocumentChunk } from "./types/document.js";
import type { GraphEdge, GraphNode } from "./types/graph.js";

export interface SubgraphQuery {
  centerNodeIds?: string[];
  nodeTypes?: string[];
  relationTypes?: string[];
  documentIds?: string[];
  minConfidence?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export interface SearchResult {
  node: GraphNode;
  score: number;
}

export interface ChunkSearchResult {
  chunk: DocumentChunk;
  score: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  documentCount: number;
  nodeTypeDistribution: Record<string, number>;
  edgeTypeDistribution: Record<string, number>;
}

export interface GraphNodeStore {
  saveNodes(nodes: GraphNode[]): Promise<void>;
  getNodeById(id: string): Promise<GraphNode | null>;
  getNodesByType(type: string, limit?: number, offset?: number): Promise<GraphNode[]>;
  searchNodes(query: string, limit?: number): Promise<SearchResult[]>;
  deleteNode(id: string): Promise<void>;
}

export interface GraphEdgeStore {
  saveEdges(edges: GraphEdge[]): Promise<void>;
  getEdgesByNode(nodeId: string): Promise<GraphEdge[]>;
  deleteEdge(id: string): Promise<void>;
}

export interface GraphQueryStore {
  getNeighbors(nodeId: string, depth?: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  getSubgraph(query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
}

export interface VectorStore {
  saveEmbeddings(nodeId: string, embedding: number[]): Promise<void>;
  vectorSearch(
    vector: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]>;
  chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]>;
}

export interface DocumentStore {
  saveDocument(doc: Document): Promise<void>;
  getDocuments(): Promise<Document[]>;
  deleteDocumentAndRelated(docId: string): Promise<void>;
  saveChunks(chunks: DocumentChunk[]): Promise<void>;
  getChunksByDocument(docId: string): Promise<DocumentChunk[]>;
}

export interface AbstractGraphStore
  extends GraphNodeStore,
    GraphEdgeStore,
    GraphQueryStore,
    VectorStore,
    DocumentStore {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getStats(): Promise<GraphStats>;
}
