import OpenAI from "openai";
import { z } from "zod";
import type { ChatMessage } from "@graphen/shared";
import {
  QUESTION_ANALYSIS_SYSTEM_PROMPT,
  buildChatSystemPrompt,
  buildExtractionSystemPrompt,
  buildInferencePrompt
} from "../prompts/index.js";
import { appConfig } from "../config.js";
import { LLMRateLimiter } from "./LLMRateLimiter.js";
import type {
  ExtractionResult,
  ExtractionSchema,
  InferredRelationRaw,
  LLMConfig,
  LLMServiceLike,
  OpenAICompatibleClient,
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

const questionAnalysisSchema = z.object({
  intent: z.enum(["factual", "analytical", "comparative", "exploratory"]),
  key_entities: z.array(z.string()),
  retrieval_strategy: z.object({
    use_graph: z.boolean(),
    use_vector: z.boolean(),
    graph_depth: z.number().int().min(0),
    vector_top_k: z.number().int().min(0).default(0),
    need_aggregation: z.boolean()
  }),
  rewritten_query: z.string().default("")
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
    options?: { documentId?: string }
  ): Promise<ExtractionResult> {
    const systemPrompt = buildExtractionSystemPrompt(schema);
    const response = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        response_format: { type: "json_object" },
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
    options?: { documentId?: string }
  ): AsyncGenerator<string> {
    const systemPrompt = buildChatSystemPrompt(context);
    const stream = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
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

  async generateEmbedding(text: string, options?: { documentId?: string }): Promise<number[]> {
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

  async analyzeQuestion(question: string, options?: { documentId?: string }): Promise<QuestionAnalysis> {
    const response = await this.rateLimiter.run(() =>
      this.client.chat.completions.create({
        model: this.config.chatModel,
        temperature: 0,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: QUESTION_ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: question }
        ]
      })
    );

    const content = response?.choices?.[0]?.message?.content ?? "{}";
    const parsed = questionAnalysisSchema.parse(safeJsonParse(content));
    this.recordUsage("analysis", this.config.chatModel, response?.usage, options?.documentId);
    return parsed;
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
