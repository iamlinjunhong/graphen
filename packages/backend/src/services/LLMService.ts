import OpenAI from "openai";
import { z } from "zod";
import type { ChatMessage } from "@graphen/shared";
import {
  ANALYSIS_PROMPT_VERSION,
  CHAT_PROMPT_VERSION,
  MEMORY_PROMPT_VERSION,
  QUERY_ANALYSIS_FAST_PATH_RULES,
  QUESTION_ANALYSIS_SYSTEM_PROMPT,
  buildChatSystemPrompt,
  buildExtractionSystemPrompt,
  buildInferencePrompt
} from "../prompts/index.js";
import { appConfig } from "../config.js";
import { LLMRateLimiter } from "./LLMRateLimiter.js";
import type {
  ConflictPolicy,
  ExtractionResult,
  ExtractionSchema,
  FastPathTrigger,
  InferredRelationRaw,
  LLMConfig,
  LLMRequestOptions,
  LLMServiceLike,
  MemoryIntent,
  OpenAICompatibleClient,
  QueryAnalysisV2,
  QueryTargetSubject,
  RetrievalWeights,
  QuestionAnalysis,
  RAGContext,
  TokenUsagePhase,
  TokenUsageRecord
} from "./llmTypes.js";

const extractionResultSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().min(1),
      type: z.string().min(1),
      description: z.string().default(""),
      confidence: z.number().min(0).max(1)
    })
  ),
  relations: z.array(
    z.object({
      source: z.string().min(1),
      target: z.string().min(1),
      type: z.string().min(1),
      description: z.string().default(""),
      confidence: z.number().min(0).max(1)
    })
  )
});

const defaultRetrievalWeights: RetrievalWeights = {
  entry_manual: 0.5,
  entry_chat: 0.5,
  entry_document: 0.5,
  graph_facts: 0.5,
  doc_chunks: 0.5
};

const retrievalWeightsSchema = z.object({
  entry_manual: z.number().min(0).max(1).default(defaultRetrievalWeights.entry_manual),
  entry_chat: z.number().min(0).max(1).default(defaultRetrievalWeights.entry_chat),
  entry_document: z.number().min(0).max(1).default(defaultRetrievalWeights.entry_document),
  graph_facts: z.number().min(0).max(1).default(defaultRetrievalWeights.graph_facts),
  doc_chunks: z.number().min(0).max(1).default(defaultRetrievalWeights.doc_chunks)
});

const questionAnalysisSchema = z.object({
  intent: z.enum(["factual", "analytical", "comparative", "exploratory"]).default("factual"),
  key_entities: z.array(z.string()).default([]),
  retrieval_strategy: z.object({
    use_graph: z.boolean().default(true),
    use_vector: z.boolean().default(true),
    graph_depth: z.number().int().min(0).default(2),
    vector_top_k: z.number().int().min(0).default(5),
    need_aggregation: z.boolean().default(false)
  }).default({}),
  rewritten_query: z.string().default(""),
  memory_intent: z.enum(["identity", "profile", "preference", "history", "none"]).default("none"),
  target_subject: z.enum(["user_self", "assistant", "third_party", "unknown"]).default("unknown"),
  must_use_memory: z.boolean().default(false),
  retrieval_weights: retrievalWeightsSchema.default(defaultRetrievalWeights),
  conflict_policy: z.enum(["latest_manual_wins", "highest_confidence_wins", "abstain"]).default("latest_manual_wins"),
  fast_path_trigger: z.enum(["identity_self", "preference_self", "history_self", "knowledge_query"]).optional()
});

const inferenceResultSchema = z.object({
  inferred_relations: z.array(
    z.object({
      source: z.string().min(1),
      target: z.string().min(1),
      relation_type: z.string().min(1),
      reasoning: z.string().default(""),
      confidence: z.number().min(0).max(1)
    })
  ).default([])
});

const modelCostPerThousandTokens: Record<TokenUsagePhase, { input: number; output: number }> = {
  extraction: { input: 0.004, output: 0.012 },
  chat: { input: 0.004, output: 0.012 },
  embedding: { input: 0.001, output: 0 },
  analysis: { input: 0.004, output: 0.012 }
};

type NormalizedLLMConfig = LLMConfig & {
  baseURL: string;
  temperature: number;
  maxTokens: number;
  maxConcurrent: number;
  maxRetries: number;
  retryDelayMs: number;
  requestsPerMinute: number;
  timeoutMs: number;
};

export class LLMService implements LLMServiceLike {
  private readonly client: OpenAICompatibleClient;
  private readonly embeddingClient: OpenAICompatibleClient;
  private readonly rateLimiter: LLMRateLimiter;
  private readonly usageRecords: TokenUsageRecord[] = [];
  private readonly config: NormalizedLLMConfig;

  constructor(
    config: LLMConfig,
    deps?: {
      client?: OpenAICompatibleClient;
      embeddingClient?: OpenAICompatibleClient;
      rateLimiter?: LLMRateLimiter;
    }
  ) {
    this.config = {
      ...config,
      baseURL: config.baseURL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      temperature: config.temperature ?? 0.1,
      maxTokens: config.maxTokens ?? 4096,
      maxConcurrent: config.maxConcurrent ?? 5,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      requestsPerMinute: config.requestsPerMinute ?? 30,
      timeoutMs: config.timeoutMs ?? 60_000
    };

    this.client =
      deps?.client ??
      new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL
      });

    // Use a separate client for embeddings if configured
    if (deps?.embeddingClient) {
      this.embeddingClient = deps.embeddingClient;
    } else if (config.embeddingApiKey && config.embeddingBaseURL) {
      this.embeddingClient = new OpenAI({
        apiKey: config.embeddingApiKey,
        baseURL: config.embeddingBaseURL
      });
    } else {
      this.embeddingClient = this.client;
    }

    this.rateLimiter =
      deps?.rateLimiter ??
      new LLMRateLimiter({
        maxConcurrent: this.config.maxConcurrent,
        maxRetries: this.config.maxRetries,
        retryDelayMs: this.config.retryDelayMs,
        requestsPerMinute: this.config.requestsPerMinute,
        timeoutMs: this.config.timeoutMs
      });
  }

  static fromEnv(): LLMService {
    const provider = appConfig.LLM_PROVIDER;

    const config: LLMConfig = {
      apiKey:
        provider === "gemini"
          ? appConfig.GEMINI_API_KEY
          : provider === "openai"
          ? appConfig.OPENAI_API_KEY
          : appConfig.QWEN_API_KEY,
      baseURL:
        provider === "gemini"
          ? appConfig.GEMINI_BASE_URL
          : provider === "openai"
          ? appConfig.OPENAI_BASE_URL
          : appConfig.QWEN_BASE_URL,
      chatModel:
        provider === "gemini"
          ? appConfig.GEMINI_CHAT_MODEL
          : provider === "openai"
          ? appConfig.OPENAI_CHAT_MODEL
          : appConfig.QWEN_CHAT_MODEL,
      embeddingModel:
        provider === "gemini"
          ? appConfig.GEMINI_EMBEDDING_MODEL
          : provider === "openai"
          ? appConfig.OPENAI_EMBEDDING_MODEL
          : appConfig.QWEN_EMBEDDING_MODEL,
      maxConcurrent: appConfig.LLM_MAX_CONCURRENT,
      maxRetries: appConfig.LLM_MAX_RETRIES,
      retryDelayMs: appConfig.LLM_RETRY_DELAY_MS,
      requestsPerMinute: appConfig.LLM_REQUESTS_PER_MINUTE,
      timeoutMs: appConfig.LLM_TIMEOUT_MS,
      temperature: 0.1,
      maxTokens: 4096
    };

    if (appConfig.EMBEDDING_API_KEY) {
      config.embeddingApiKey = appConfig.EMBEDDING_API_KEY;
    }
    if (appConfig.EMBEDDING_BASE_URL) {
      config.embeddingBaseURL = appConfig.EMBEDDING_BASE_URL;
    }

    return new LLMService(config);
  }

  async extractEntitiesAndRelations(
    text: string,
    schema?: ExtractionSchema,
    options?: LLMRequestOptions
  ): Promise<ExtractionResult> {
    const systemPrompt = buildExtractionSystemPrompt(schema);
    const response = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        response_format: { type: "json_object" },
        metadata: buildRequestMetadata(
          {
            promptName: "extraction",
            promptVersion: "1.0.0"
          },
          options
        ),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ]
      })
    );

    const content = response?.choices?.[0]?.message?.content ?? "{}";
    const parsedJson = safeJsonParse(content);
    const parsed = extractionResultSchema.parse(parsedJson);

    this.recordUsage("extraction", this.config.chatModel, response?.usage, options?.documentId);
    return parsed;
  }

  async *chatCompletion(
    messages: ChatMessage[],
    context: RAGContext,
    options?: LLMRequestOptions
  ): AsyncGenerator<string> {
    const systemPrompt = buildChatSystemPrompt(context);
    const promptName = options?.promptName ?? "chat";
    const defaultPromptVersion = promptName === "memory"
      ? MEMORY_PROMPT_VERSION
      : CHAT_PROMPT_VERSION;

    const stream = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        metadata: buildRequestMetadata(
          {
            promptName,
            promptVersion: defaultPromptVersion
          },
          options
        ),
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map((message) => ({
            role: message.role,
            content: message.content
          }))
        ]
      })
    );

    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    for await (const chunk of stream as AsyncIterable<any>) {
      usage = chunk?.usage ?? usage;
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) {
        yield String(delta);
      }
    }

    this.recordUsage("chat", this.config.chatModel, usage, options?.documentId);
  }

  async generateEmbedding(text: string, options?: LLMRequestOptions): Promise<number[]> {
    const isOpenAI = appConfig.LLM_PROVIDER === "openai";
    const dimensions = appConfig.EMBEDDING_DIMENSIONS;

    const response = await this.rateLimiter.run(() =>
      this.embeddingClient.embeddings.create({
        model: this.config.embeddingModel,
        input: text,
        ...(isOpenAI && dimensions ? { dimensions } : {})
      })
    );

    this.recordUsage("embedding", this.config.embeddingModel, response?.usage, options?.documentId);
    return (response?.data?.[0]?.embedding ?? []) as number[];
  }

  async analyzeQuestion(question: string, options?: LLMRequestOptions): Promise<QuestionAnalysis> {
    const fastPathResult = this.checkFastPath(question);
    if (fastPathResult) {
      return fastPathResult;
    }

    const response = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: 0,
        max_tokens: 800,
        response_format: { type: "json_object" },
        metadata: buildRequestMetadata(
          {
            promptName: "analysis",
            promptVersion: ANALYSIS_PROMPT_VERSION
          },
          options
        ),
        messages: [
          { role: "system", content: QUESTION_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: question }
        ]
      })
    );

    const content = response?.choices?.[0]?.message?.content ?? "{}";
    const parsed = normalizeQuestionAnalysis(questionAnalysisSchema.parse(safeJsonParse(content)));
    this.recordUsage("analysis", this.config.chatModel, response?.usage, options?.documentId);
    return parsed;
  }

  checkFastPath(question: string): QueryAnalysisV2 | null {
    const normalizedQuestion = question.trim();
    if (normalizedQuestion.length === 0) {
      return null;
    }

    for (const rule of QUERY_ANALYSIS_FAST_PATH_RULES) {
      if (!rule.pattern.test(normalizedQuestion)) {
        continue;
      }
      return buildFastPathAnalysis(
        normalizedQuestion,
        rule.fast_path_trigger,
        rule.retrieval_weights,
        rule.must_use_memory
      );
    }

    return null;
  }

  getUsageRecords(limit = 200): TokenUsageRecord[] {
    const safeLimit = Math.max(1, limit);
    return this.usageRecords.slice(-safeLimit);
  }

  async inferRelations(triples: string): Promise<InferredRelationRaw[]> {
    if (triples.trim().length === 0) {
      return [];
    }

    const prompt = buildInferencePrompt(triples);
    const response = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        metadata: buildRequestMetadata({
          promptName: "inference",
          promptVersion: "1.0.0"
        }),
        messages: [
          { role: "system", content: prompt }
        ]
      })
    );

    const content = response?.choices?.[0]?.message?.content ?? "{}";
    const parsed = inferenceResultSchema.parse(safeJsonParse(content));
    this.recordUsage("analysis", this.config.chatModel, response?.usage);

    return parsed.inferred_relations
      .filter((r) => r.confidence >= 0.5)
      .slice(0, 5);
  }

  clearUsageRecords(): void {
    this.usageRecords.length = 0;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private recordUsage(
    phase: TokenUsagePhase,
    model: string,
    usage:
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        }
      | undefined,
    documentId?: string
  ): void {
    const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;

    const costSpec = modelCostPerThousandTokens[phase];
    const estimatedCost =
      (promptTokens / 1000) * costSpec.input + (completionTokens / 1000) * costSpec.output;

    const record: TokenUsageRecord = {
      phase,
      model,
      promptTokens,
      completionTokens,
      estimatedCost,
      timestamp: new Date()
    };
    if (documentId !== undefined) {
      record.documentId = documentId;
    }
    this.usageRecords.push(record);
  }
}

const fastPathPresetByTrigger: Record<
  FastPathTrigger,
  {
    memoryIntent: MemoryIntent;
    targetSubject: QueryTargetSubject;
    conflictPolicy: ConflictPolicy;
    intent: QueryAnalysisV2["intent"];
    useGraph: boolean;
    useVector: boolean;
    graphDepth: number;
    vectorTopK: number;
    keyEntities: string[];
  }
> = {
  identity_self: {
    memoryIntent: "identity",
    targetSubject: "user_self",
    conflictPolicy: "latest_manual_wins",
    intent: "factual",
    useGraph: true,
    useVector: true,
    graphDepth: 1,
    vectorTopK: 4,
    keyEntities: ["用户"]
  },
  preference_self: {
    memoryIntent: "preference",
    targetSubject: "user_self",
    conflictPolicy: "latest_manual_wins",
    intent: "analytical",
    useGraph: true,
    useVector: true,
    graphDepth: 1,
    vectorTopK: 5,
    keyEntities: ["用户"]
  },
  history_self: {
    memoryIntent: "history",
    targetSubject: "user_self",
    conflictPolicy: "latest_manual_wins",
    intent: "analytical",
    useGraph: true,
    useVector: true,
    graphDepth: 2,
    vectorTopK: 6,
    keyEntities: ["用户"]
  },
  knowledge_query: {
    memoryIntent: "none",
    targetSubject: "unknown",
    conflictPolicy: "latest_manual_wins",
    intent: "factual",
    useGraph: true,
    useVector: true,
    graphDepth: 2,
    vectorTopK: 8,
    keyEntities: []
  }
};

function buildFastPathAnalysis(
  question: string,
  trigger: FastPathTrigger,
  retrievalWeights: RetrievalWeights,
  mustUseMemory: boolean
): QueryAnalysisV2 {
  const preset = fastPathPresetByTrigger[trigger];
  return {
    intent: preset.intent,
    key_entities: preset.keyEntities,
    retrieval_strategy: {
      use_graph: preset.useGraph,
      use_vector: preset.useVector,
      graph_depth: preset.graphDepth,
      vector_top_k: preset.vectorTopK,
      need_aggregation: false
    },
    rewritten_query: question,
    memory_intent: preset.memoryIntent,
    target_subject: preset.targetSubject,
    must_use_memory: mustUseMemory,
    retrieval_weights: retrievalWeights,
    conflict_policy: preset.conflictPolicy,
    fast_path_trigger: trigger
  };
}

function normalizeQuestionAnalysis(parsed: QueryAnalysisV2): QueryAnalysisV2 {
  const normalizedWeights: RetrievalWeights = {
    entry_manual: clampWeight(parsed.retrieval_weights.entry_manual),
    entry_chat: clampWeight(parsed.retrieval_weights.entry_chat),
    entry_document: clampWeight(parsed.retrieval_weights.entry_document),
    graph_facts: clampWeight(parsed.retrieval_weights.graph_facts),
    doc_chunks: clampWeight(parsed.retrieval_weights.doc_chunks)
  };

  const normalizedKeyEntities = dedupeStrings(parsed.key_entities);
  const normalizedIntent = parsed.memory_intent;
  const mustUseMemory = parsed.must_use_memory || normalizedIntent !== "none";

  const normalized: QueryAnalysisV2 = {
    intent: parsed.intent,
    memory_intent: parsed.memory_intent,
    target_subject: parsed.target_subject,
    conflict_policy: parsed.conflict_policy,
    key_entities: normalizedKeyEntities,
    retrieval_strategy: {
      ...parsed.retrieval_strategy,
      graph_depth: clampInt(parsed.retrieval_strategy.graph_depth, 0, 4),
      vector_top_k: clampInt(parsed.retrieval_strategy.vector_top_k, 0, 20)
    },
    rewritten_query: parsed.rewritten_query.trim(),
    must_use_memory: mustUseMemory,
    retrieval_weights: normalizedWeights
  };

  if (parsed.fast_path_trigger !== undefined) {
    normalized.fast_path_trigger = parsed.fast_path_trigger;
  }

  return normalized;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    const match = input.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function buildRequestMetadata(
  defaults: {
    promptName: string;
    promptVersion: string;
  },
  options?: LLMRequestOptions
): Record<string, string> {
  const metadata: Record<string, string> = {
    prompt_name: options?.promptName ?? defaults.promptName,
    prompt_version: options?.promptVersion ?? defaults.promptVersion
  };

  if (options?.documentId) {
    metadata.document_id = options.documentId;
  }

  if (options?.metadata) {
    for (const [key, value] of Object.entries(options.metadata)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === "string") {
        metadata[key] = value;
        continue;
      }
      metadata[key] = JSON.stringify(value);
    }
  }

  return metadata;
}

function clampWeight(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)));
}
