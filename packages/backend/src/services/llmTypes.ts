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
export type MemoryIntent = "identity" | "profile" | "preference" | "history" | "none";
export type QueryTargetSubject = "user_self" | "assistant" | "third_party" | "unknown";
export type ConflictPolicy = "latest_manual_wins" | "highest_confidence_wins" | "abstain";
export type FastPathTrigger = "identity_self" | "preference_self" | "history_self" | "knowledge_query";

export interface RetrievalWeights {
  entry_manual: number;
  entry_chat: number;
  entry_document: number;
  graph_facts: number;
  doc_chunks: number;
}

export interface QueryAnalysisV2 {
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
  memory_intent: MemoryIntent;
  target_subject: QueryTargetSubject;
  must_use_memory: boolean;
  retrieval_weights: RetrievalWeights;
  conflict_policy: ConflictPolicy;
  fast_path_trigger?: FastPathTrigger | undefined;
}

export type QuestionAnalysis = QueryAnalysisV2;

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

export interface LLMRequestOptions {
  documentId?: string;
  promptName?: string;
  promptVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface LLMServiceLike {
  extractEntitiesAndRelations(
    text: string,
    schema?: ExtractionSchema,
    options?: LLMRequestOptions
  ): Promise<ExtractionResult>;
  chatCompletion(
    messages: ChatMessage[],
    context: RAGContext,
    options?: LLMRequestOptions
  ): AsyncGenerator<string>;
  generateEmbedding(text: string, options?: LLMRequestOptions): Promise<number[]>;
  analyzeQuestion(question: string, options?: LLMRequestOptions): Promise<QuestionAnalysis>;
  inferRelations?(triples: string): Promise<InferredRelationRaw[]>;
  estimateTokens?(text: string): number;
}
