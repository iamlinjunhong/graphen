import type {
  AbstractGraphStore,
  ChunkSearchResult,
  Document,
  DocumentChunk,
  GraphEdge,
  GraphNode,
  GraphStats,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";

export class FakeGraphStore implements AbstractGraphStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly documents = new Map<string, Document>();
  private readonly chunks = new Map<string, DocumentChunk>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }

  async saveNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, { ...node });
    }
  }

  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async getNodesByType(type: string, limit = 50, offset = 0): Promise<GraphNode[]> {
    const items = [...this.nodes.values()]
      .filter((node) => node.type === type)
      .sort((a, b) => a.name.localeCompare(b.name));
    return items.slice(offset, offset + limit);
  }

  async searchNodes(query: string, limit = 10): Promise<SearchResult[]> {
    const normalized = query.toLowerCase();
    const matches = [...this.nodes.values()]
      .filter((node) => {
        return (
          node.name.toLowerCase().includes(normalized) ||
          node.description.toLowerCase().includes(normalized)
        );
      })
      .slice(0, limit);
    return matches.map((node) => ({
      node,
      score: 1
    }));
  }

  async deleteNode(id: string): Promise<void> {
    this.nodes.delete(id);
    for (const edge of [...this.edges.values()]) {
      if (edge.sourceNodeId === id || edge.targetNodeId === id) {
        this.edges.delete(edge.id);
      }
    }
  }

  async saveEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      this.edges.set(edge.id, { ...edge });
    }
  }

  async getEdgesByNode(nodeId: string): Promise<GraphEdge[]> {
    return [...this.edges.values()].filter(
      (edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId
    );
  }

  async deleteEdge(id: string): Promise<void> {
    this.edges.delete(id);
  }

  async getNeighbors(
    nodeId: string,
    depth = 1
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    if (!this.nodes.has(nodeId)) {
      return { nodes: [], edges: [] };
    }

    const safeDepth = Math.max(1, depth);
    const visited = new Set<string>([nodeId]);
    let frontier = new Set<string>([nodeId]);

    for (let i = 0; i < safeDepth; i += 1) {
      const next = new Set<string>();
      for (const edge of this.edges.values()) {
        if (frontier.has(edge.sourceNodeId)) {
          next.add(edge.targetNodeId);
        }
        if (frontier.has(edge.targetNodeId)) {
          next.add(edge.sourceNodeId);
        }
      }

      frontier = new Set([...next].filter((id) => !visited.has(id)));
      for (const id of frontier) {
        visited.add(id);
      }
      if (frontier.size === 0) {
        break;
      }
    }

    const nodes = [...visited]
      .map((id) => this.nodes.get(id))
      .filter((node): node is GraphNode => node !== undefined);
    const edges = [...this.edges.values()].filter(
      (edge) => visited.has(edge.sourceNodeId) && visited.has(edge.targetNodeId)
    );
    return { nodes, edges };
  }

  async getSubgraph(query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    let nodes = [...this.nodes.values()];

    if (query.centerNodeIds && query.centerNodeIds.length > 0) {
      const visited = new Set<string>();
      for (const centerNodeId of query.centerNodeIds) {
        const neighbors = await this.getNeighbors(centerNodeId, query.maxDepth ?? 2);
        for (const node of neighbors.nodes) {
          visited.add(node.id);
        }
      }
      nodes = nodes.filter((node) => visited.has(node.id));
    }

    if (query.nodeTypes && query.nodeTypes.length > 0) {
      nodes = nodes.filter((node) => query.nodeTypes?.includes(node.type));
    }
    if (query.documentIds && query.documentIds.length > 0) {
      nodes = nodes.filter((node) =>
        node.sourceDocumentIds.some((id) => query.documentIds?.includes(id))
      );
    }
    if (query.minConfidence !== undefined) {
      nodes = nodes.filter((node) => node.confidence >= query.minConfidence!);
    }
    if (query.maxNodes !== undefined) {
      nodes = nodes.slice(0, query.maxNodes);
    }

    const allowed = new Set(nodes.map((node) => node.id));
    let edges = [...this.edges.values()].filter(
      (edge) => allowed.has(edge.sourceNodeId) && allowed.has(edge.targetNodeId)
    );

    if (query.relationTypes && query.relationTypes.length > 0) {
      edges = edges.filter((edge) => query.relationTypes?.includes(edge.relationType));
    }
    if (query.documentIds && query.documentIds.length > 0) {
      edges = edges.filter((edge) =>
        edge.sourceDocumentIds.some((id) => query.documentIds?.includes(id))
      );
    }
    if (query.minConfidence !== undefined) {
      edges = edges.filter((edge) => edge.confidence >= query.minConfidence!);
    }

    return { nodes, edges };
  }

  async saveEmbeddings(nodeId: string, embedding: number[]): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }
    this.nodes.set(nodeId, {
      ...node,
      embedding: [...embedding]
    });
  }

  async vectorSearch(
    vector: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    if (vector.length === 0) {
      return [];
    }

    let nodes = [...this.nodes.values()];
    if (filter && filter.type && typeof filter.type === "string") {
      nodes = nodes.filter((node) => node.type === filter.type);
    }

    return nodes.slice(0, k).map((node, index) => ({
      node,
      score: Math.max(0, 1 - index * 0.01)
    }));
  }

  async chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]> {
    if (vector.length === 0) {
      return [];
    }

    return [...this.chunks.values()].slice(0, k).map((chunk, index) => ({
      chunk,
      score: Math.max(0, 1 - index * 0.01)
    }));
  }

  async saveDocument(doc: Document): Promise<void> {
    this.documents.set(doc.id, { ...doc });
  }

  async getDocuments(): Promise<Document[]> {
    return [...this.documents.values()].sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()
    );
  }

  async deleteDocumentAndRelated(docId: string): Promise<void> {
    this.documents.delete(docId);
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.documentId === docId) {
        this.chunks.delete(chunk.id);
      }
    }

    for (const node of [...this.nodes.values()]) {
      const sourceDocumentIds = node.sourceDocumentIds.filter((id) => id !== docId);
      if (sourceDocumentIds.length === 0) {
        this.nodes.delete(node.id);
      } else {
        this.nodes.set(node.id, {
          ...node,
          sourceDocumentIds
        });
      }
    }

    for (const edge of [...this.edges.values()]) {
      const sourceDocumentIds = edge.sourceDocumentIds.filter((id) => id !== docId);
      if (sourceDocumentIds.length === 0) {
        this.edges.delete(edge.id);
      } else {
        this.edges.set(edge.id, {
          ...edge,
          sourceDocumentIds
        });
      }
    }
  }

  async saveChunks(chunks: DocumentChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, { ...chunk });
    }
  }

  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.documentId === docId)
      .sort((a, b) => a.index - b.index);
  }

  async getStats(): Promise<GraphStats> {
    const nodeTypeDistribution: Record<string, number> = {};
    const edgeTypeDistribution: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      nodeTypeDistribution[node.type] = (nodeTypeDistribution[node.type] ?? 0) + 1;
    }
    for (const edge of this.edges.values()) {
      edgeTypeDistribution[edge.relationType] = (edgeTypeDistribution[edge.relationType] ?? 0) + 1;
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      documentCount: this.documents.size,
      nodeTypeDistribution,
      edgeTypeDistribution
    };
  }
}
