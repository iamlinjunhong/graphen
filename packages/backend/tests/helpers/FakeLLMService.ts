import type { ChatMessage } from "@graphen/shared";
import type {
  ExtractionResult,
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
      rewritten_query: "Graphen 与 Neo4j 的关系"
    };
    this.chatChunks = options.chatChunks ?? ["Graphen ", "使用 ", "Neo4j。"];
    this.embedding = options.embedding ?? [0.1, 0.2, 0.3, 0.4];
  }

  async extractEntitiesAndRelations(
    _text: string
  ): Promise<ExtractionResult> {
    return {
      entities: [],
      relations: []
    };
  }

  async *chatCompletion(
    _messages: ChatMessage[],
    context: RAGContext
  ): AsyncGenerator<string> {
    this.lastContext = context;
    for (const chunk of this.chatChunks) {
      yield chunk;
    }
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    return [...this.embedding];
  }

  async analyzeQuestion(_question: string): Promise<QuestionAnalysis> {
    return this.analysis;
  }
}
