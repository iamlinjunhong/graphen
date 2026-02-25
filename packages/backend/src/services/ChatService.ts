import type {
  AbstractGraphStore,
  ChunkSearchResult,
  GraphEdge,
  GraphNode,
  SearchResult
} from "@graphen/shared";
import type { ChatMessage, ChatSession, ChatSource } from "@graphen/shared";
import type { ChatStoreLike } from "./ChatStore.js";
import type { LLMServiceLike, QuestionAnalysis } from "./llmTypes.js";

export class ChatSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Chat session does not exist: ${sessionId}`);
    this.name = "ChatSessionNotFoundError";
  }
}

interface ChatServiceOptions {
  historyLimit: number;
  maxGraphContextNodes: number;
  maxGraphContextEdges: number;
  maxChunkContextLength: number;
  entitySearchLimit: number;
}

const defaultOptions: ChatServiceOptions = {
  historyLimit: 20,
  maxGraphContextNodes: 30,
  maxGraphContextEdges: 60,
  maxChunkContextLength: 350,
  entitySearchLimit: 5
};

export type ChatStreamEvent =
  | {
      type: "analysis";
      analysis: QuestionAnalysis;
    }
  | {
      type: "delta";
      delta: string;
    }
  | {
      type: "sources";
      sources: ChatSource[];
      graphContext: { nodes: string[]; edges: string[] };
    }
  | {
      type: "done";
      message: ChatMessage;
    };

interface SendMessageInput {
  sessionId: string;
  content: string;
  model?: string;
}

interface RetrievedContext {
  graphContextText: string;
  retrievedChunksText: string;
  sources: ChatSource[];
  graphContext: { nodes: string[]; edges: string[] };
}

export class ChatService {
  private readonly options: ChatServiceOptions;

  constructor(
    private readonly graphStore: AbstractGraphStore,
    private readonly chatStore: ChatStoreLike,
    private readonly llmService: LLMServiceLike,
    options: Partial<ChatServiceOptions> = {}
  ) {
    this.options = {
      ...defaultOptions,
      ...options
    };
  }

  createSession(input: { title: string }): ChatSession {
    return this.chatStore.createSession(input);
  }

  listSessions(limit?: number): ChatSession[] {
    return this.chatStore.listSessions(limit);
  }

  getSessionWithMessages(
    sessionId: string
  ): { session: ChatSession; messages: ChatMessage[] } | null {
    return this.chatStore.getSessionWithMessages(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.chatStore.deleteSession(sessionId);
  }

  async completeMessage(input: SendMessageInput): Promise<ChatMessage> {
    let doneMessage: ChatMessage | null = null;

    for await (const event of this.streamMessage(input)) {
      if (event.type === "done") {
        doneMessage = event.message;
      }
    }

    if (!doneMessage) {
      throw new Error("Chat completion stream finished without a final message.");
    }

    return doneMessage;
  }

  async *streamMessage(input: SendMessageInput): AsyncGenerator<ChatStreamEvent> {
    const session = this.chatStore.getSessionById(input.sessionId);
    if (!session) {
      throw new ChatSessionNotFoundError(input.sessionId);
    }

    this.chatStore.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.content
    });

    const analysis = await this.llmService.analyzeQuestion(input.content);
    yield {
      type: "analysis",
      analysis
    };

    const context = await this.retrieveContext(input.content, analysis);
    const history = this.chatStore
      .listMessagesBySession(input.sessionId)
      .slice(-this.options.historyLimit);

    let answer = "";
    const completionOptions: { documentId?: string } = {};
    const firstSource = context.sources[0];
    if (firstSource) {
      completionOptions.documentId = firstSource.documentId;
    }

    for await (const delta of this.llmService.chatCompletion(
      history,
      {
        graphContext: context.graphContextText,
        retrievedChunks: context.retrievedChunksText
      },
      completionOptions
    )) {
      if (delta.length === 0) {
        continue;
      }
      answer += delta;
      yield {
        type: "delta",
        delta
      };
    }

    const finalizedAnswer = answer.trim().length > 0 ? answer : "抱歉，我暂时无法基于当前上下文给出回答。";
    const assistantMessage = this.chatStore.addMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: finalizedAnswer,
      sources: context.sources,
      graphContext: context.graphContext
    });

    yield {
      type: "sources",
      sources: context.sources,
      graphContext: context.graphContext
    };
    yield {
      type: "done",
      message: assistantMessage
    };
  }

  private async retrieveContext(
    question: string,
    analysis: QuestionAnalysis
  ): Promise<RetrievedContext> {
    const graphContext = await this.retrieveGraphContext(question, analysis);
    const vectorContext = await this.retrieveVectorContext(question, analysis);

    return {
      graphContextText: this.buildGraphContextText(graphContext.nodes, graphContext.edges),
      retrievedChunksText: this.buildChunkContextText(vectorContext.chunks),
      sources: vectorContext.sources,
      graphContext: {
        nodes: graphContext.nodes.map((node) => node.id),
        edges: graphContext.edges.map((edge) => edge.id)
      }
    };
  }

  private async retrieveGraphContext(
    question: string,
    analysis: QuestionAnalysis
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    if (!analysis.retrieval_strategy.use_graph) {
      return { nodes: [], edges: [] };
    }

    const centerNodeIds = await this.collectCenterNodeIds(question, analysis);
    if (centerNodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    const maxDepth = clampInt(analysis.retrieval_strategy.graph_depth, 1, 4);
    const maxNodes = Math.max(50, this.options.maxGraphContextNodes * 3);
    const subgraph = await this.graphStore.getSubgraph({
      centerNodeIds,
      maxDepth,
      maxNodes
    });

    const nodes = subgraph.nodes.slice(0, this.options.maxGraphContextNodes);
    const allowedNodeIds = new Set(nodes.map((node) => node.id));
    const edges = subgraph.edges
      .filter(
        (edge) =>
          allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId)
      )
      .slice(0, this.options.maxGraphContextEdges);

    return { nodes, edges };
  }

  private async collectCenterNodeIds(
    question: string,
    analysis: QuestionAnalysis
  ): Promise<string[]> {
    const candidates = dedupeStrings([
      ...analysis.key_entities,
      analysis.rewritten_query,
      question
    ]);
    const hits: SearchResult[] = [];

    for (const candidate of candidates.slice(0, 6)) {
      const searchResults = await this.graphStore.searchNodes(
        candidate,
        this.options.entitySearchLimit
      );
      hits.push(...searchResults);
    }

    const sorted = hits.sort((a, b) => b.score - a.score);
    return dedupeStrings(sorted.map((item) => item.node.id)).slice(0, 8);
  }

  private async retrieveVectorContext(
    question: string,
    analysis: QuestionAnalysis
  ): Promise<{ chunks: ChunkSearchResult[]; sources: ChatSource[] }> {
    if (!analysis.retrieval_strategy.use_vector) {
      return { chunks: [], sources: [] };
    }

    const embeddingInput = analysis.rewritten_query.trim().length > 0
      ? analysis.rewritten_query
      : question;
    const vector = await this.llmService.generateEmbedding(embeddingInput);
    if (vector.length === 0) {
      return { chunks: [], sources: [] };
    }

    const topK = clampInt(analysis.retrieval_strategy.vector_top_k, 1, 20);
    const chunks = await this.graphStore.chunkVectorSearch(vector, topK);
    const documents = await this.graphStore.getDocuments();
    const nameByDocumentId = new Map(
      documents.map((document) => [document.id, document.filename])
    );

    const sources: ChatSource[] = chunks.map(({ chunk, score }) => {
      const source: ChatSource = {
        documentId: chunk.documentId,
        documentName: nameByDocumentId.get(chunk.documentId) ?? chunk.documentId,
        chunkId: chunk.id,
        relevanceScore: score,
        snippet: trimSnippet(chunk.content, this.options.maxChunkContextLength)
      };
      if (chunk.metadata.pageNumber !== undefined) {
        source.pageNumber = chunk.metadata.pageNumber;
      }
      return source;
    });

    return { chunks, sources };
  }

  private buildGraphContextText(nodes: GraphNode[], edges: GraphEdge[]): string {
    if (nodes.length === 0 && edges.length === 0) {
      return "（无图谱上下文）";
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeLines = nodes.map(
      (node) => `- ${node.name} (${node.type}): ${trimSnippet(node.description, 160)}`
    );
    const edgeLines = edges.map((edge) => {
      const sourceName = nodeById.get(edge.sourceNodeId)?.name ?? edge.sourceNodeId;
      const targetName = nodeById.get(edge.targetNodeId)?.name ?? edge.targetNodeId;
      return `- ${sourceName} -[${edge.relationType}]-> ${targetName}`;
    });

    return [
      "实体：",
      ...nodeLines,
      "",
      "关系：",
      ...edgeLines
    ].join("\n");
  }

  private buildChunkContextText(chunks: ChunkSearchResult[]): string {
    if (chunks.length === 0) {
      return "（无文档片段）";
    }

    return chunks
      .map(({ chunk, score }, index) => {
        const snippet = trimSnippet(chunk.content, this.options.maxChunkContextLength);
        return `[${index + 1}] doc=${chunk.documentId} chunk=${chunk.id} score=${score.toFixed(4)}\n${snippet}`;
      })
      .join("\n\n");
  }
}

function trimSnippet(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function dedupeStrings(values: string[]): string[] {
  const items = values
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(items));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
