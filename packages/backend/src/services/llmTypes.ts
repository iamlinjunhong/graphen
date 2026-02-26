import type { ChatMessage } from "@graphen/shared";

export interface ExtractionSchema {
  entityTypes?: string[];
  relationTypes?: string[];
}

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  confidence: number;
}

export interface ExtractedRelation {
  source: string;
  target: string;
  type: string;
  description: string;
  confidence: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export interface RAGContext {
  graphContext: string;
  retrievedChunks: string;
}

export type QuestionIntent = "factual" | "analytical" | "comparative" | "exploratory";

export interface QuestionAnalysis {
  intent: QuestionIntent;
  key_entities: string[];
  retrieval_strategy: {
    use_graph: boolean;
    use_vector: boolean;
    graph_depth: number;
    vector_top_k: number;
    need_aggregation: boolean;
  };
  rewritten_query: string;
}

export interface LLMConfig {
  apiKey: string;
  baseURL?: string;
  chatModel: string;
  embeddingModel: string;
  embeddingApiKey?: string;
  embeddingBaseURL?: string;
  temperature?: number;
  maxTokens?: number;
  maxConcurrent?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  requestsPerMinute?: number;
  timeoutMs?: number;
}

export interface LLMRateLimitConfig {
  maxConcurrent: number;
  maxRetries: number;
  retryDelayMs: number;
  requestsPerMinute: number;
  timeoutMs: number;
}

export type TokenUsagePhase = "extraction" | "chat" | "embedding" | "analysis";

export interface TokenUsageRecord {
  documentId?: string;
  phase: TokenUsagePhase;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  timestamp: Date;
}

export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create: (...args: any[]) => Promise<any>;
    };
  };
  embeddings: {
    create: (...args: any[]) => Promise<any>;
  };
}

export interface InferredRelationRaw {
  source: string;
  target: string;
  relation_type: string;
  reasoning: string;
  confidence: number;
}

export interface LLMServiceLike {
  extractEntitiesAndRelations(
    text: string,
    schema?: ExtractionSchema,
    options?: { documentId?: string }
  ): Promise<ExtractionResult>;
  chatCompletion(
    messages: ChatMessage[],
    context: RAGContext,
    options?: { documentId?: string }
  ): AsyncGenerator<string>;
  generateEmbedding(text: string, options?: { documentId?: string }): Promise<number[]>;
  analyzeQuestion(question: string, options?: { documentId?: string }): Promise<QuestionAnalysis>;
  inferRelations?(triples: string): Promise<InferredRelationRaw[]>;
  estimateTokens?(text: string): number;
}
