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
  SubgraphQuery,
} from "@graphen/shared";
import { DocumentPipeline } from "../../../src/pipeline/DocumentPipeline.js";
import type {
  ExtractionResult,
  ExtractionSchema,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext,
} from "../../../src/services/llmTypes.js";
import type { ChatMessage } from "@graphen/shared";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildDocument(overrides?: Partial<Document>): Document {
  return {
    id: randomUUID(),
    filename: "test.txt",
    fileType: "txt",
    fileSize: 0,
    status: "uploading",
    uploadedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePipeline(store: FakeGraphStore, llm: SpyLLMService, cacheDir: string) {
  return new DocumentPipeline(store, llm, undefined, {
    cacheDir,
    chunkSize: 80,
    chunkOverlap: 0,
    maxChunksPerDocument: 50,
    maxEstimatedTokens: 50_000,
    extractionConcurrency: 2,
    embeddingConcurrency: 2,
  });
}

describe("DocumentPipeline rawText + forceRebuild", () => {
  it("uses rawText directly and skips parseFile when rawText is provided", async () => {
    const cacheDir = resolve("tmp", `pipeline-rawtext-${randomUUID()}`);
    cleanupDirs.push(cacheDir);

    const store = new FakeGraphStore();
    const llm = new SpyLLMService();
    const pipeline = makePipeline(store, llm, cacheDir);

    const doc = buildDocument({ fileType: "md" });
    // fileBuffer contains different text than rawText
    const fileBuffer = Buffer.from("# This should NOT be used", "utf8");
    const rawText = "Edited content from the editor";

    const result = await pipeline.process(doc, fileBuffer, { rawText });

    // Chunks should be based on rawText, not fileBuffer
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.chunks[0].content).toContain("Edited content");
    // Should NOT contain the markdown header from fileBuffer
    for (const chunk of result.chunks) {
      expect(chunk.content).not.toContain("This should NOT be used");
    }
  });

  it("does not reuse old cache when forceRebuild=true", async () => {
    const cacheDir = resolve("tmp", `pipeline-force-${randomUUID()}`);
    cleanupDirs.push(cacheDir);

    const store = new FakeGraphStore();
    const llm = new SpyLLMService();
    const pipeline = makePipeline(store, llm, cacheDir);

    const doc = buildDocument();
    const originalText = "Graphen uses Neo4j for graph storage and vector search capabilities.";

    // First run: populates cache
    const result1 = await pipeline.process(doc, Buffer.from(originalText, "utf8"));
    const firstExtractionCalls = llm.extractionCalls;
    expect(firstExtractionCalls).toBeGreaterThan(0);

    // Verify cache files exist
    const chunksPath = resolve(cacheDir, doc.id, "chunks.json");
    const extractionsPath = resolve(cacheDir, doc.id, "extractions.json");
    expect(existsSync(chunksPath)).toBe(true);
    expect(existsSync(extractionsPath)).toBe(true);

    // Second run with forceRebuild: should NOT reuse cache
    llm.resetCalls();
    const editedText = "Completely different content after user editing in the document editor.";
    const result2 = await pipeline.process(doc, Buffer.from(originalText, "utf8"), {
      rawText: editedText,
      forceRebuild: true,
    });

    // Extraction should be called again (not reused from cache)
    expect(llm.extractionCalls).toBeGreaterThan(0);
    // Chunks should reflect the edited text
    expect(result2.chunks[0].content).toContain("Completely different");
    // Cache should be overwritten with new data
    const cachedChunks = JSON.parse(readFileSync(chunksPath, "utf8"));
    expect(cachedChunks[0].content).toContain("Completely different");
  });

  it("preserves original behavior when no rawText or forceRebuild", async () => {
    const cacheDir = resolve("tmp", `pipeline-default-${randomUUID()}`);
    cleanupDirs.push(cacheDir);

    const store = new FakeGraphStore();
    const llm = new SpyLLMService();
    const pipeline = makePipeline(store, llm, cacheDir);

    const doc = buildDocument();
    const text = "Graphen is a knowledge graph application built with Neo4j.";

    // First run
    await pipeline.process(doc, Buffer.from(text, "utf8"));
    const firstCalls = llm.extractionCalls;
    expect(firstCalls).toBeGreaterThan(0);

    // Second run without forceRebuild: should reuse cache
    llm.resetCalls();
    llm.failOnExtraction = true; // Would throw if extraction is called

    const result2 = await pipeline.process(doc, Buffer.from(text, "utf8"));
    expect(llm.extractionCalls).toBe(0); // Cache was reused
    expect(result2.chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Test doubles ───

class SpyLLMService implements LLMServiceLike {
  extractionCalls = 0;
  embeddingCalls = 0;
  failOnExtraction = false;

  resetCalls(): void {
    this.extractionCalls = 0;
    this.embeddingCalls = 0;
    this.failOnExtraction = false;
  }

  async extractEntitiesAndRelations(
    text: string,
    _schema?: ExtractionSchema,
    _options?: { documentId?: string }
  ): Promise<ExtractionResult> {
    this.extractionCalls += 1;
    if (this.failOnExtraction) {
      throw new Error("Extraction should not be called when cache is reused");
    }
    return {
      entities: [
        { name: "Graphen", type: "Technology", description: "GraphRAG app", confidence: 0.95 },
      ],
      relations: [
        { source: "Graphen", target: "Neo4j", type: "USES", description: "uses", confidence: 0.9 },
      ],
    };
  }

  async *chatCompletion(
    _messages: ChatMessage[],
    _context: RAGContext
  ): AsyncGenerator<string> {
    yield "unused";
  }

  async generateEmbedding(text: string): Promise<number[]> {
    this.embeddingCalls += 1;
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
        need_aggregation: false,
      },
      rewritten_query: "unused",
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
  async healthCheck(): Promise<boolean> { return true; }
  async getStats() {
    return {
      nodeCount: this.savedNodes.length,
      edgeCount: this.savedEdges.length,
      documentCount: this.savedDocuments.length,
      nodeTypeDistribution: {},
      edgeTypeDistribution: {},
    };
  }
  async saveNodes(nodes: GraphNode[]): Promise<void> { this.savedNodes = [...nodes]; }
  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.savedNodes.find((n) => n.id === id) ?? null;
  }
  async getNodesByType(type: string): Promise<GraphNode[]> {
    return this.savedNodes.filter((n) => n.type === type);
  }
  async searchNodes(): Promise<SearchResult[]> {
    return this.savedNodes.map((node) => ({ node, score: 1 }));
  }
  async deleteNode(id: string): Promise<void> {
    this.savedNodes = this.savedNodes.filter((n) => n.id !== id);
  }
  async saveEdges(edges: GraphEdge[]): Promise<void> { this.savedEdges = [...edges]; }
  async getEdgesByNode(nodeId: string): Promise<GraphEdge[]> {
    return this.savedEdges.filter((e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId);
  }
  async deleteEdge(id: string): Promise<void> {
    this.savedEdges = this.savedEdges.filter((e) => e.id !== id);
  }
  async getNeighbors(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return { nodes: this.savedNodes, edges: this.savedEdges };
  }
  async getSubgraph(_query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return { nodes: this.savedNodes, edges: this.savedEdges };
  }
  async saveEmbeddings(nodeId: string, embedding: number[]): Promise<void> {
    const node = this.savedNodes.find((n) => n.id === nodeId);
    if (node) node.embedding = embedding;
  }
  async vectorSearch(): Promise<SearchResult[]> {
    return this.savedNodes.map((node) => ({ node, score: 1 }));
  }
  async chunkVectorSearch(): Promise<{ chunk: DocumentChunk; score: number }[]> {
    return this.savedChunks.map((chunk) => ({ chunk, score: 1 }));
  }
  async saveDocument(doc: Document): Promise<void> { this.savedDocuments = [doc]; }
  async getDocuments(): Promise<Document[]> { return this.savedDocuments; }
  async deleteDocumentAndRelated(docId: string): Promise<void> {
    this.savedDocuments = this.savedDocuments.filter((d) => d.id !== docId);
  }
  async saveChunks(chunks: DocumentChunk[]): Promise<void> { this.savedChunks = [...chunks]; }
  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    return this.savedChunks.filter((c) => c.documentId === docId);
  }
}
