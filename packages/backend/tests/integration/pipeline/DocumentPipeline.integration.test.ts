import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AbstractGraphStore,
  Document,
  DocumentChunk,
  GraphEdge,
  GraphNode,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";
import { DocumentPipeline } from "../../../src/pipeline/DocumentPipeline.js";
import type {
  ExtractionResult,
  LLMServiceLike,
  QuestionAnalysis
} from "../../../src/services/llmTypes.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("DocumentPipeline integration", () => {
  it("processes document end-to-end with 6 phases and writes cache", async () => {
    const cacheDir = resolve("tmp", `pipeline-cache-${randomUUID()}`);
    cleanupDirs.push(cacheDir);

    const store = new FakeGraphStore();
    const llm = new FakeLLMService();
    const emitter = new EventEmitter();
    const phases: string[] = [];
    emitter.on("status", (event: { phase: string }) => {
      phases.push(event.phase);
    });

    const pipeline = new DocumentPipeline(store, llm, emitter, {
      cacheDir,
      chunkSize: 40,
      chunkOverlap: 5,
      maxChunksPerDocument: 20,
      maxEstimatedTokens: 10_000,
      extractionConcurrency: 3,
      embeddingConcurrency: 3
    });

    const doc = buildDocument();
    const text =
      "Graphen uses Neo4j as graph store. Graphen includes document pipeline and chat module.";
    const result = await pipeline.process(doc, Buffer.from(text, "utf8"));

    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    expect(result.resolvedGraph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(store.savedNodes.length).toBeGreaterThanOrEqual(2);
    expect(store.savedEdges.length).toBeGreaterThanOrEqual(1);
    expect(store.savedDocuments.length).toBe(1);

    expect(phases).toEqual([
      "parsing",
      "chunking",
      "extracting",
      "resolving",
      "embedding",
      "saving",
      "completed"
    ]);

    const chunksPath = resolve(cacheDir, doc.id, "chunks.json");
    const extractionsPath = resolve(cacheDir, doc.id, "extractions.json");
    expect(existsSync(chunksPath)).toBe(true);
    expect(existsSync(extractionsPath)).toBe(true);
    expect(JSON.parse(readFileSync(chunksPath, "utf8"))).toHaveLength(result.chunks.length);
  });

  it("resumes from extraction cache without re-calling extraction", async () => {
    const cacheDir = resolve("tmp", `pipeline-resume-${randomUUID()}`);
    cleanupDirs.push(cacheDir);

    const store = new FakeGraphStore();
    const llm = new FakeLLMService();
    const pipeline = new DocumentPipeline(store, llm, undefined, {
      cacheDir,
      chunkSize: 50,
      chunkOverlap: 0,
      maxChunksPerDocument: 20,
      maxEstimatedTokens: 10_000
    });

    const doc = buildDocument();
    const text = "Graphen uses Neo4j. Neo4j stores vectors.";
    await pipeline.process(doc, Buffer.from(text, "utf8"));

    const firstCalls = llm.extractionCalls;
    expect(firstCalls).toBeGreaterThan(0);

    llm.resetExtractionCalls();
    llm.failOnExtraction = true;

    await pipeline.process(doc, Buffer.from(text, "utf8"));
    expect(llm.extractionCalls).toBe(0);
  });

  it("throws when chunk limit is exceeded", async () => {
    const cacheDir = resolve("tmp", `pipeline-limit-${randomUUID()}`);
    cleanupDirs.push(cacheDir);

    const store = new FakeGraphStore();
    const llm = new FakeLLMService();
    const pipeline = new DocumentPipeline(store, llm, undefined, {
      cacheDir,
      chunkSize: 10,
      chunkOverlap: 0,
      maxChunksPerDocument: 1,
      maxEstimatedTokens: 10_000
    });

    const doc = buildDocument();
    await expect(
      pipeline.process(
        doc,
        Buffer.from("Graphen uses Neo4j and also supports vector search and chat.", "utf8")
      )
    ).rejects.toThrow(/Chunk count limit exceeded/i);
  });
});

class FakeLLMService implements LLMServiceLike {
  extractionCalls = 0;
  failOnExtraction = false;

  resetExtractionCalls(): void {
    this.extractionCalls = 0;
  }

  async extractEntitiesAndRelations(text: string): Promise<ExtractionResult> {
    this.extractionCalls += 1;
    if (this.failOnExtraction) {
      throw new Error("Extraction should not be called when cache exists");
    }

    const entities = [
      {
        name: "Graphen",
        type: "Technology",
        description: "GraphRAG application",
        confidence: 0.95
      }
    ];
    if (/neo4j/i.test(text)) {
      entities.push({
        name: "Neo4j",
        type: "Technology",
        description: "Graph database",
        confidence: 0.94
      });
    }

    return {
      entities,
      relations: [
        {
          source: "Graphen",
          target: "Neo4j",
          type: "USES",
          description: "Graphen uses Neo4j",
          confidence: 0.9
        }
      ]
    };
  }

  async *chatCompletion(
    _messages?: any,
    _context?: any,
    _options?: { documentId?: string }
  ): AsyncGenerator<string> {
    yield "unused";
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const seed = Math.max(1, text.length % 10);
    return [seed / 10, (seed + 1) / 10, (seed + 2) / 10, (seed + 3) / 10];
  }

  async analyzeQuestion(_question: string): Promise<QuestionAnalysis> {
    return {
      intent: "factual",
      key_entities: [],
      retrieval_strategy: {
        use_graph: true,
        use_vector: true,
        graph_depth: 1,
        vector_top_k: 3,
        need_aggregation: false
      },
      rewritten_query: "unused"
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

class FakeGraphStore implements AbstractGraphStore {
  savedNodes: GraphNode[] = [];
  savedEdges: GraphEdge[] = [];
  savedChunks: DocumentChunk[] = [];
  savedDocuments: Document[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async getStats() {
    return {
      nodeCount: this.savedNodes.length,
      edgeCount: this.savedEdges.length,
      documentCount: this.savedDocuments.length,
      nodeTypeDistribution: {},
      edgeTypeDistribution: {}
    };
  }

  async saveNodes(nodes: GraphNode[]): Promise<void> {
    this.savedNodes = [...nodes];
  }
  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.savedNodes.find((node) => node.id === id) ?? null;
  }
  async getNodesByType(type: string): Promise<GraphNode[]> {
    return this.savedNodes.filter((node) => node.type === type);
  }
  async searchNodes(_query: string): Promise<SearchResult[]> {
    return this.savedNodes.map((node) => ({ node, score: 1 }));
  }
  async deleteNode(id: string): Promise<void> {
    this.savedNodes = this.savedNodes.filter((node) => node.id !== id);
  }

  async saveEdges(edges: GraphEdge[]): Promise<void> {
    this.savedEdges = [...edges];
  }
  async getEdgesByNode(nodeId: string): Promise<GraphEdge[]> {
    return this.savedEdges.filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId);
  }
  async deleteEdge(id: string): Promise<void> {
    this.savedEdges = this.savedEdges.filter((edge) => edge.id !== id);
  }

  async getNeighbors(nodeId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return {
      nodes: this.savedNodes.filter((node) =>
        this.savedEdges.some((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
      ),
      edges: this.savedEdges
    };
  }
  async getSubgraph(_query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return { nodes: this.savedNodes, edges: this.savedEdges };
  }

  async saveEmbeddings(nodeId: string, embedding: number[]): Promise<void> {
    const node = this.savedNodes.find((item) => item.id === nodeId);
    if (node) {
      node.embedding = embedding;
    }
  }
  async vectorSearch(_vector: number[], _k: number): Promise<SearchResult[]> {
    return this.savedNodes.map((node) => ({ node, score: 1 }));
  }
  async chunkVectorSearch(_vector: number[], _k: number): Promise<{ chunk: DocumentChunk; score: number }[]> {
    return this.savedChunks.map((chunk) => ({ chunk, score: 1 }));
  }

  async saveDocument(doc: Document): Promise<void> {
    this.savedDocuments = [doc];
  }
  async getDocuments(): Promise<Document[]> {
    return this.savedDocuments;
  }
  async deleteDocumentAndRelated(docId: string): Promise<void> {
    this.savedDocuments = this.savedDocuments.filter((doc) => doc.id !== docId);
  }
  async saveChunks(chunks: DocumentChunk[]): Promise<void> {
    this.savedChunks = [...chunks];
  }
  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    return this.savedChunks.filter((chunk) => chunk.documentId === docId);
  }
}

function buildDocument(): Document {
  return {
    id: randomUUID(),
    filename: "doc.txt",
    fileType: "txt",
    fileSize: 0,
    status: "uploading",
    uploadedAt: new Date(),
    metadata: {}
  };
}
