import { randomUUID } from "node:crypto";
import type {
  AbstractGraphStore,
  ChunkSearchResult,
  Document,
  DocumentChunk,
  GraphEdge,
  GraphNode,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";
import { appConfig } from "../config.js";
import { DocumentPipeline } from "../pipeline/DocumentPipeline.js";
import { closePgPoolSingleton, getPgPoolSingleton } from "../runtime/PgPool.js";
import { ChatService } from "../services/ChatService.js";
import { InMemoryChatStore } from "../services/InMemoryChatStore.js";
import { MemoryExtractor } from "../services/MemoryExtractor.js";
import { MemoryService } from "../services/MemoryService.js";
import { PgDocumentStore } from "../services/PgDocumentStore.js";
import { PgMemoryStore } from "../services/PgMemoryStore.js";
import type {
  ExtractionResult,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext
} from "../services/llmTypes.js";

class Phase3FakeLLM implements LLMServiceLike {
  public lastChatContext: RAGContext | null = null;

  async extractEntitiesAndRelations(_text: string): Promise<ExtractionResult> {
    return {
      entities: [
        {
          name: "Graphen",
          type: "Technology",
          description: "GraphRAG platform",
          confidence: 0.95
        },
        {
          name: "张三",
          type: "Person",
          description: "Graphen CTO",
          confidence: 0.94
        }
      ],
      relations: [
        {
          source: "张三",
          target: "Graphen",
          type: "任职于",
          description: "张三在 Graphen 任职",
          confidence: 0.92
        }
      ]
    };
  }

  async *chatCompletion(
    messages: Array<{ content: string }>,
    context: RAGContext
  ): AsyncGenerator<string> {
    const message = messages[0]?.content ?? "";
    const isMemoryExtraction =
      context.graphContext.includes("事实提取助手")
      || message.includes("请从以下消息中提取事实");

    if (isMemoryExtraction) {
      yield JSON.stringify({
        facts: [
          {
            subject: "张三",
            predicate: "职位",
            object: "CTO",
            valueType: "text",
            confidence: 0.95
          }
        ]
      });
      return;
    }

    this.lastChatContext = context;
    yield "Phase3 chat response";
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    return buildEmbedding(7);
  }

  async analyzeQuestion(_question: string): Promise<QuestionAnalysis> {
    return {
      intent: "factual",
      key_entities: ["张三"],
      retrieval_strategy: {
        use_graph: true,
        use_vector: true,
        graph_depth: 1,
        vector_top_k: 5,
        need_aggregation: false
      },
      rewritten_query: "张三在 Graphen 的职位",
      memory_intent: "none",
      target_subject: "unknown",
      must_use_memory: false,
      retrieval_weights: {
        entry_manual: 0.2,
        entry_chat: 0.2,
        entry_document: 0.4,
        graph_facts: 0.8,
        doc_chunks: 0.8
      },
      conflict_policy: "latest_manual_wins"
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

class CountingGraphStore implements AbstractGraphStore {
  public chunkVectorSearchCalls = 0;
  public saveDocumentCalls = 0;
  public saveChunksCalls = 0;
  public saveNodesCalls = 0;
  public saveEdgesCalls = 0;
  public saveEmbeddingsCalls = 0;

  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly documents = new Map<string, Document>();
  private readonly chunks = new Map<string, DocumentChunk>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async getStats() {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      documentCount: this.documents.size,
      nodeTypeDistribution: {},
      edgeTypeDistribution: {}
    };
  }

  async saveNodes(nodes: GraphNode[]): Promise<void> {
    this.saveNodesCalls += 1;
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }
  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.nodes.get(id) ?? null;
  }
  async getNodesByType(type: string): Promise<GraphNode[]> {
    return [...this.nodes.values()].filter((node) => node.type === type);
  }
  async searchNodes(query: string): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase();
    return [...this.nodes.values()]
      .filter((node) => node.name.toLowerCase().includes(q))
      .map((node) => ({ node, score: 1 }));
  }
  async deleteNode(id: string): Promise<void> {
    this.nodes.delete(id);
  }

  async saveEdges(edges: GraphEdge[]): Promise<void> {
    this.saveEdgesCalls += 1;
    for (const edge of edges) {
      this.edges.set(edge.id, edge);
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

  async getNeighbors(nodeId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const edges = await this.getEdgesByNode(nodeId);
    const ids = new Set<string>();
    for (const edge of edges) {
      ids.add(edge.sourceNodeId);
      ids.add(edge.targetNodeId);
    }
    const nodes = [...ids].map((id) => this.nodes.get(id)).filter((node): node is GraphNode => !!node);
    return { nodes, edges };
  }
  async getSubgraph(query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const centerIds = new Set(query.centerNodeIds ?? []);
    if (centerIds.size === 0) {
      return { nodes: [], edges: [] };
    }
    const edges = [...this.edges.values()].filter(
      (edge) => centerIds.has(edge.sourceNodeId) || centerIds.has(edge.targetNodeId)
    );
    const ids = new Set<string>(query.centerNodeIds ?? []);
    for (const edge of edges) {
      ids.add(edge.sourceNodeId);
      ids.add(edge.targetNodeId);
    }
    const nodes = [...ids].map((id) => this.nodes.get(id)).filter((node): node is GraphNode => !!node);
    return { nodes, edges };
  }

  async saveEmbeddings(nodeId: string, embedding: number[]): Promise<void> {
    this.saveEmbeddingsCalls += 1;
    const node = this.nodes.get(nodeId);
    if (node) {
      node.embedding = embedding;
    }
  }
  async vectorSearch(_vector: number[], _k: number): Promise<SearchResult[]> {
    return [];
  }
  async chunkVectorSearch(_vector: number[], _k: number): Promise<ChunkSearchResult[]> {
    this.chunkVectorSearchCalls += 1;
    return [];
  }

  async saveDocument(doc: Document): Promise<void> {
    this.saveDocumentCalls += 1;
    this.documents.set(doc.id, doc);
  }
  async getDocuments(): Promise<Document[]> {
    return [...this.documents.values()];
  }
  async deleteDocumentAndRelated(docId: string): Promise<void> {
    this.documents.delete(docId);
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.documentId === docId) {
        this.chunks.delete(chunkId);
      }
    }
  }
  async saveChunks(chunks: DocumentChunk[]): Promise<void> {
    this.saveChunksCalls += 1;
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
  }
  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    return [...this.chunks.values()].filter((chunk) => chunk.documentId === docId);
  }
}

function buildEmbedding(seed: number): number[] {
  const result = new Array<number>(appConfig.EMBEDDING_DIMENSIONS);
  for (let i = 0; i < result.length; i++) {
    result[i] = Number((((seed + i) % 97) / 97).toFixed(6));
  }
  return result;
}

interface IdentityExtractionCase {
  id: string;
  message: string;
  subject: string;
  predicate: string;
  object: string;
  expectedPredicate: string;
}

class Phase3IdentityExtractionLLM implements LLMServiceLike {
  private readonly caseByMessage: Map<string, IdentityExtractionCase>;

  constructor(cases: IdentityExtractionCase[]) {
    this.caseByMessage = new Map(cases.map((item) => [item.message, item]));
  }

  async extractEntitiesAndRelations(_text: string): Promise<ExtractionResult> {
    return { entities: [], relations: [] };
  }

  async *chatCompletion(
    messages: Array<{ content: string }>,
    context: RAGContext
  ): AsyncGenerator<string> {
    const message = messages[0]?.content ?? "";
    const isMemoryExtraction =
      context.graphContext.includes("事实提取助手")
      || message.includes("请从以下消息中提取事实");
    if (isMemoryExtraction) {
      const sourceMessage = extractMemorySourceMessage(message);
      const testCase = this.caseByMessage.get(sourceMessage);
      if (!testCase) {
        yield JSON.stringify({
          should_store: false,
          entry_summary: "",
          facts: [],
          rejection_reason: "未命中测试样本"
        });
        return;
      }

      yield JSON.stringify({
        should_store: true,
        entry_summary: `${testCase.id} 用户记忆摘要`,
        facts: [
          {
            subject: testCase.subject,
            predicate: testCase.predicate,
            object: testCase.object,
            valueType: "text",
            confidence: 0.96
          }
        ],
        rejection_reason: ""
      });
      return;
    }

    yield "Phase3 identity extraction response";
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    return buildEmbedding(11);
  }

  async analyzeQuestion(_question: string): Promise<QuestionAnalysis> {
    return {
      intent: "factual",
      key_entities: ["用户"],
      retrieval_strategy: {
        use_graph: false,
        use_vector: false,
        graph_depth: 1,
        vector_top_k: 3,
        need_aggregation: false
      },
      rewritten_query: "用户身份信息",
      memory_intent: "profile",
      target_subject: "user_self",
      must_use_memory: true,
      retrieval_weights: {
        entry_manual: 1.0,
        entry_chat: 0.8,
        entry_document: 0.1,
        graph_facts: 0.1,
        doc_chunks: 0.1
      },
      conflict_policy: "latest_manual_wins"
    };
  }
}

function extractMemorySourceMessage(userPrompt: string): string {
  const marker = "请从以下消息中提取事实：";
  const index = userPrompt.indexOf(marker);
  if (index < 0) {
    return userPrompt.trim();
  }
  return userPrompt.slice(index + marker.length).trim();
}

function buildIdentityExtractionCases(): IdentityExtractionCase[] {
  return [
    { id: "D4-01", message: "我是张三。", subject: "我", predicate: "是", object: "张三", expectedPredicate: "身份" },
    { id: "D4-02", message: "我叫李四。", subject: "我", predicate: "叫", object: "李四", expectedPredicate: "姓名" },
    { id: "D4-03", message: "我的名字是王五。", subject: "我", predicate: "名字", object: "王五", expectedPredicate: "姓名" },
    { id: "D4-04", message: "我的职业是后端工程师。", subject: "我", predicate: "职业", object: "后端工程师", expectedPredicate: "职业" },
    { id: "D4-05", message: "我的工作是产品经理。", subject: "我", predicate: "工作", object: "产品经理", expectedPredicate: "职业" },
    { id: "D4-06", message: "我的职位是架构师。", subject: "我", predicate: "职位", object: "架构师", expectedPredicate: "职业" },
    { id: "D4-07", message: "我的身份是自由职业者。", subject: "我", predicate: "身份", object: "自由职业者", expectedPredicate: "身份" },
    { id: "D4-08", message: "我来自上海。", subject: "我", predicate: "来自", object: "上海", expectedPredicate: "来源地" },
    { id: "D4-09", message: "我的家乡是杭州。", subject: "我", predicate: "家乡", object: "杭州", expectedPredicate: "来源地" },
    { id: "D4-10", message: "我的籍贯是苏州。", subject: "我", predicate: "籍贯", object: "苏州", expectedPredicate: "来源地" },
    { id: "D4-11", message: "你叫赵六。", subject: "你", predicate: "叫", object: "赵六", expectedPredicate: "姓名" },
    { id: "D4-12", message: "你的职业是设计师。", subject: "你", predicate: "职业", object: "设计师", expectedPredicate: "职业" },
    { id: "D4-13", message: "您来自北京。", subject: "您", predicate: "来自", object: "北京", expectedPredicate: "来源地" },
    { id: "D4-14", message: "本人叫陈七。", subject: "本人", predicate: "叫", object: "陈七", expectedPredicate: "姓名" },
    { id: "D4-15", message: "咱是测试工程师。", subject: "咱", predicate: "是", object: "测试工程师", expectedPredicate: "职业" },
    { id: "D4-16", message: "我自己的身份是创业者。", subject: "我自己", predicate: "身份", object: "创业者", expectedPredicate: "身份" },
    { id: "D4-17", message: "我偏好咖啡。", subject: "我", predicate: "偏好", object: "咖啡", expectedPredicate: "偏好" },
    { id: "D4-18", message: "我喜欢跑步。", subject: "我", predicate: "喜欢", object: "跑步", expectedPredicate: "偏好" },
    { id: "D4-19", message: "我不喜欢香菜。", subject: "我", predicate: "不喜欢", object: "香菜", expectedPredicate: "偏好" },
    { id: "D4-20", message: "俺来自成都。", subject: "俺", predicate: "来自", object: "成都", expectedPredicate: "来源地" }
  ];
}

async function main(): Promise<void> {
  const runTag = randomUUID().slice(0, 8);
  const entryStore = new PgMemoryStore();
  const documentStore = new PgDocumentStore();
  const memoryService = new MemoryService(entryStore);
  const llm = new Phase3FakeLLM();
  const graphStore = new CountingGraphStore();

  const cleanupEntryIds: string[] = [];
  const cleanupDocumentIds: string[] = [];
  const pgPool = getPgPoolSingleton();

  try {
    // Seed minimal graph context nodes/edges for chat graph path.
    const now = new Date("2026-03-04T00:00:00.000Z");
    await graphStore.saveNodes([
      {
        id: "node-zhangsan",
        name: "张三",
        type: "Person",
        description: "Graphen CTO",
        properties: {},
        sourceDocumentIds: [],
        sourceChunkIds: [],
        confidence: 0.95,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "node-graphen",
        name: "Graphen",
        type: "Technology",
        description: "GraphRAG platform",
        properties: {},
        sourceDocumentIds: [],
        sourceChunkIds: [],
        confidence: 0.94,
        createdAt: now,
        updatedAt: now
      }
    ]);
    await graphStore.saveEdges([
      {
        id: "edge-works-at",
        sourceNodeId: "node-zhangsan",
        targetNodeId: "node-graphen",
        relationType: "任职于",
        description: "张三在 Graphen 任职",
        properties: {},
        weight: 1,
        sourceDocumentIds: [],
        confidence: 0.9,
        createdAt: now
      }
    ]);
    graphStore.saveNodesCalls = 0;
    graphStore.saveEdgesCalls = 0;

    // T3.1 MemoryExtractor Entry/Fact layering + dedupe on normalized_content_key
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });
    const message = `Phase3 ${runTag}：张三是 Graphen 的 CTO`;

    await extractor.enqueue({
      message,
      sourceType: "chat_user",
      chatSessionId: `phase3-session-${runTag}`,
      chatMessageId: `phase3-msg-1-${runTag}`,
      nodeIdMap: new Map([
        ["张三", "node-zhangsan"],
        ["Graphen", "node-graphen"]
      ])
    });

    await extractor.enqueue({
      message,
      sourceType: "chat_user",
      chatSessionId: `phase3-session-${runTag}`,
      chatMessageId: `phase3-msg-2-${runTag}`,
      nodeIdMap: new Map([
        ["张三", "node-zhangsan"],
        ["Graphen", "node-graphen"]
      ])
    });

    const matchedEntries = await entryStore.searchEntries({
      query: message,
      page: 1,
      pageSize: 10
    });
    if (matchedEntries.total < 1) {
      throw new Error("T3.1 failed: extractor did not create entry");
    }
    if (matchedEntries.total > 1) {
      throw new Error("T3.1 failed: duplicate entry not merged by normalized_content_key");
    }
    const extractedEntry = matchedEntries.entries[0];
    if (!extractedEntry) {
      throw new Error("T3.1 failed: missing extracted entry");
    }
    cleanupEntryIds.push(extractedEntry.id);

    const extractedFacts = await entryStore.getEntryFacts(extractedEntry.id);
    if (extractedFacts.length === 0 || extractedFacts.some((fact) => fact.entryId !== extractedEntry.id)) {
      throw new Error("T3.1 failed: facts are not linked to entry_id");
    }
    if (extractor.pendingCount !== 0 || extractor.isProcessing) {
      throw new Error("T3.1 failed: async queue not drained");
    }

    // T3.2 DocumentPipeline writes documents/chunks to PG + chunk embedding
    const pipeline = new DocumentPipeline(
      graphStore,
      llm,
      undefined,
      {
        chunkSize: 80,
        chunkOverlap: 10,
        maxChunksPerDocument: 50,
        maxEstimatedTokens: 100_000
      },
      {
        memoryService,
        documentStore
      }
    );

    const documentId = randomUUID();
    cleanupDocumentIds.push(documentId);
    await pipeline.process(
      {
        id: documentId,
        filename: `phase3-${runTag}.txt`,
        fileType: "txt",
        fileSize: 0,
        status: "uploading",
        uploadedAt: new Date(),
        metadata: {}
      },
      Buffer.from("张三是 Graphen 的 CTO。Graphen 提供 GraphRAG 服务。", "utf8")
    );

    const savedDoc = await documentStore.getDocumentById(documentId);
    const savedChunks = await documentStore.getChunksByDocument(documentId);
    if (!savedDoc || savedChunks.length === 0) {
      throw new Error("T3.2 failed: document/chunks were not persisted to PostgreSQL");
    }
    if (savedChunks.some((chunk) => !chunk.embedding || chunk.embedding.length === 0)) {
      throw new Error("T3.2 failed: chunk embedding missing in PostgreSQL vector column");
    }
    if (
      graphStore.saveDocumentCalls > 0 ||
      graphStore.saveChunksCalls > 0 ||
      graphStore.saveNodesCalls > 0 ||
      graphStore.saveEdgesCalls > 0 ||
      graphStore.saveEmbeddingsCalls > 0
    ) {
      throw new Error("T3.2 failed: Neo4j write path is still invoked by DocumentPipeline");
    }

    // T3.3 ChatService retrieves chunk + memory entry context from PG vectors
    const chatStore = new InMemoryChatStore();
    const session = chatStore.createSession({ title: `Phase3 chat ${runTag}` });

    const chatService = new ChatService(
      graphStore,
      chatStore,
      llm,
      {},
      {
        entryStore,
        chunkContextStore: documentStore,
        recordEntryAccessLogs: async (input) => {
          const entryIds = Array.from(new Set(input.entryIds));
          if (entryIds.length === 0) {
            return;
          }
          await pgPool.query(
            `
              INSERT INTO memory_access_logs (entry_id, chat_session_id, access_type)
              SELECT id::uuid, $2, $3
              FROM unnest($1::text[]) AS id
            `,
            [entryIds, input.chatSessionId, input.accessType]
          );
        }
      }
    );

    const assistantMessage = await chatService.completeMessage({
      sessionId: session.id,
      content: "张三在 Graphen 的职位是什么？"
    });

    if (!assistantMessage.sources || assistantMessage.sources.length === 0) {
      throw new Error("T3.3 failed: chunk sources were not retrieved from PG");
    }
    if (graphStore.chunkVectorSearchCalls > 0) {
      throw new Error("T3.3 failed: ChatService still called graphStore.chunkVectorSearch");
    }
    const packedContext = llm.lastChatContext?.graphContext ?? "";
    if (!packedContext.includes("<memory_primary>") || !packedContext.includes("<entry")) {
      throw new Error("T3.3 failed: memory primary XML context missing");
    }
    if (!llm.lastChatContext?.retrievedChunks.includes("Graphen")) {
      throw new Error("T3.3 failed: PG chunk vector context missing");
    }
    const logResult = await pgPool.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total
        FROM memory_access_logs
        WHERE chat_session_id = $1
          AND access_type = 'context_injection'
      `,
      [session.id]
    );
    if ((logResult.rows[0]?.total ?? 0) < 1) {
      throw new Error("T3.3 failed: context_injection access logs missing");
    }

    // T3.4 First-person identity extraction accuracy (>= 95%)
    const identityCases = buildIdentityExtractionCases();
    const identityLLM = new Phase3IdentityExtractionLLM(identityCases);
    const identityExtractor = new MemoryExtractor(identityLLM, memoryService, {}, { entryStore });
    let identityPassed = 0;
    for (const [index, testCase] of identityCases.entries()) {
      await identityExtractor.enqueue({
        message: testCase.message,
        sourceType: "chat_user",
        chatSessionId: `phase3-d4-session-${runTag}`,
        chatMessageId: `phase3-d4-msg-${runTag}-${index + 1}`
      });

      const searchResult = await entryStore.searchEntries({
        query: testCase.id,
        page: 1,
        pageSize: 5,
        sortBy: "updatedAt",
        sortOrder: "desc"
      });
      const entry = searchResult.entries.find((item) => item.content.includes(testCase.id));
      if (!entry) {
        throw new Error(`T3.4 failed: missing extracted entry for ${testCase.id}`);
      }
      cleanupEntryIds.push(entry.id);

      const facts = await entryStore.getEntryFacts(entry.id);
      const fact = facts[0];
      if (!fact) {
        throw new Error(`T3.4 failed: missing extracted fact for ${testCase.id}`);
      }
      if (fact.subjectText === "用户" && fact.predicate === testCase.expectedPredicate) {
        identityPassed += 1;
      }
    }

    const identityAccuracy = identityPassed / identityCases.length;
    if (identityAccuracy < 0.95) {
      throw new Error(
        `T3.4 failed: identity extraction accuracy below threshold (${identityPassed}/${identityCases.length}, ${(identityAccuracy * 100).toFixed(2)}%)`
      );
    }

    console.log("Phase 3 completed successfully.");
    console.log(`Run tag: ${runTag}`);
    console.log("T3.1 MemoryExtractor entry/fact layering: ok");
    console.log("T3.2 DocumentPipeline writes documents/chunks to PG: ok");
    console.log("T3.3 ChatService retrieves chunk + memory entry context from PG: ok");
    console.log(`T3.4 First-person identity extraction accuracy: ${(identityAccuracy * 100).toFixed(2)}% (${identityPassed}/${identityCases.length})`);
  } finally {
    if (cleanupEntryIds.length > 0) {
      await entryStore.deleteEntries(cleanupEntryIds);
    }
    for (const docId of cleanupDocumentIds) {
      await documentStore.deleteDocumentAndRelated(docId);
    }
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`Phase 3 failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
  } else {
    console.error(`Phase 3 failed: ${String(error)}`);
  }
  process.exitCode = 1;
});
