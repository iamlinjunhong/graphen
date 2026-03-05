import type { ChatMessage } from "@graphen/shared";
import type {
  ExtractionSchema,
  ExtractionResult,
  LLMRequestOptions,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext
} from "../../src/services/llmTypes.js";

interface FakeLLMServiceOptions {
  analysis?: QuestionAnalysis;
  chatChunks?: string[];
  embedding?: number[];
}

export class FakeLLMService implements LLMServiceLike {
  lastContext: RAGContext | null = null;

  private readonly analysis: QuestionAnalysis;
  private readonly chatChunks: string[];
  private readonly embedding: number[];

  constructor(options: FakeLLMServiceOptions = {}) {
    this.analysis = options.analysis ?? {
      intent: "analytical",
      key_entities: ["Graphen", "Neo4j"],
      retrieval_strategy: {
        use_graph: true,
        use_vector: true,
        graph_depth: 2,
        vector_top_k: 3,
        need_aggregation: false
      },
      rewritten_query: "Graphen 与 Neo4j 的关系",
      memory_intent: "none",
      target_subject: "unknown",
      must_use_memory: false,
      retrieval_weights: {
        entry_manual: 0.2,
        entry_chat: 0.2,
        entry_document: 0.4,
        graph_facts: 0.8,
        doc_chunks: 0.9
      },
      conflict_policy: "latest_manual_wins"
    };
    this.chatChunks = options.chatChunks ?? ["Graphen ", "使用 ", "Neo4j。"];
    this.embedding = options.embedding ?? [0.1, 0.2, 0.3, 0.4];
  }

  async extractEntitiesAndRelations(
    _text: string,
    _schema?: ExtractionSchema,
    _options?: LLMRequestOptions
  ): Promise<ExtractionResult> {
    return {
      entities: [],
      relations: []
    };
  }

  async *chatCompletion(
    _messages: ChatMessage[],
    context: RAGContext,
    _options?: LLMRequestOptions
  ): AsyncGenerator<string> {
    this.lastContext = context;
    for (const chunk of this.chatChunks) {
      yield chunk;
    }
  }

  async generateEmbedding(_text: string, _options?: LLMRequestOptions): Promise<number[]> {
    return [...this.embedding];
  }

  async analyzeQuestion(_question: string, _options?: LLMRequestOptions): Promise<QuestionAnalysis> {
    return this.analysis;
  }
}
