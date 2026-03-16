import type {
  AbstractGraphStore,
  ChunkSearchResult,
  Document,
  GraphEdge,
  GraphNode,
  InferredRelation,
  MemoryEntry,
  MemoryEntryStoreLike,
  MemoryFact,
  MemoryServiceLike,
  SearchResult
} from "@graphen/shared";
import type { ChatMessage, ChatSession, ChatSource, SourcePath } from "@graphen/shared";
import type { ChatStoreLike } from "./chatStoreTypes.js";
import type { MemoryExtractor } from "./MemoryExtractor.js";
import type {
  LLMServiceLike,
  QueryAnalysisV2,
  QuestionAnalysis
} from "./llmTypes.js";
import { buildTitleGenerationPrompt } from "../prompts/titlePrompt.js";
import { getPromptVersions } from "../prompts/versions.js";
import { appConfig } from "../config.js";
import { buildFallbackTextEmbedding } from "../utils/fallbackEmbedding.js";
import { logger } from "../utils/logger.js";

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
      sourcePaths: SourcePath[];
      inferredRelations: InferredRelation[];
    }
  | {
      type: "memory";
      facts: MemoryFact[];
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
  sourcePaths: SourcePath[];
  inferredRelations: InferredRelation[];
  accessLogEntryIds: string[];
  memoryHitCount: number;
  retrievalPlan: RetrievalPlan;
  contextSections: ContextSections;
  shortQueryMode: boolean;
  conflictDetected: boolean;
  filteredOutMemoryCount: number;
}

interface RetrievalPlan {
  graphDepth: number;
  vectorTopK: number;
  entryTopK: number;
  memoryFactLimit: number;
  useGraph: boolean;
  useVector: boolean;
  sectionBudget: SectionBudget;
}

interface ContextSections {
  memory_primary: ContextEntry[];
  memory_secondary: ContextEntry[];
  graph_facts: string[];
  doc_chunks: ChunkSearchResult[];
}

interface ContextEntry {
  id: string;
  source: "manual" | "chat_user" | "document";
  content: string;
  score: number;
  updated_at: string;
  conflict?: boolean;
}

interface SectionBudget {
  memory_primary: number;
  memory_secondary: number;
  graph_facts: number;
  doc_chunks: number;
  doc_chunk_chars: number;
  short_query_mode: boolean;
}

interface ChunkContextStoreLike {
  chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]>;
  getDocuments(): Promise<Document[]>;
}

export class ChatService {
  private readonly options: ChatServiceOptions;
  private readonly memoryService: MemoryServiceLike | undefined;
  private readonly memoryExtractor: MemoryExtractor | undefined;
  private readonly entryStore: MemoryEntryStoreLike | undefined;
  private readonly chunkContextStore: ChunkContextStoreLike | undefined;
  private readonly recordEntryAccessLogs:
    | ((input: { entryIds: string[]; chatSessionId: string; accessType: string }) => Promise<void>)
    | undefined;

  constructor(
    private readonly graphStore: AbstractGraphStore,
    private readonly chatStore: ChatStoreLike,
    private readonly llmService: LLMServiceLike,
    options: Partial<ChatServiceOptions> = {},
    deps?: {
      memoryService?: MemoryServiceLike;
      memoryExtractor?: MemoryExtractor;
      entryStore?: MemoryEntryStoreLike;
      chunkContextStore?: ChunkContextStoreLike;
      recordEntryAccessLogs?: (input: {
        entryIds: string[];
        chatSessionId: string;
        accessType: string;
      }) => Promise<void>;
    }
  ) {
    this.options = {
      ...defaultOptions,
      ...options
    };
    this.memoryService = deps?.memoryService;
    this.memoryExtractor = deps?.memoryExtractor;
    this.entryStore = deps?.entryStore;
    this.chunkContextStore = deps?.chunkContextStore;
    this.recordEntryAccessLogs = deps?.recordEntryAccessLogs;
  }

  async createSession(input: { title: string }): Promise<ChatSession> {
    return this.chatStore.createSession(input);
  }

  async listSessions(limit?: number): Promise<ChatSession[]> {
    return this.chatStore.listSessions(limit);
  }

  async getSessionWithMessages(
    sessionId: string
  ): Promise<{ session: ChatSession; messages: ChatMessage[] } | null> {
    return this.chatStore.getSessionWithMessages(sessionId);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.chatStore.deleteSession(sessionId);
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    return this.chatStore.updateSessionTitle(sessionId, title);
  }

  async generateSmartTitle(sessionId: string): Promise<string | null> {
    const data = await this.chatStore.getSessionWithMessages(sessionId);
    if (!data) throw new ChatSessionNotFoundError(sessionId);

    const { messages } = data;
    const userMsg = messages.find(m => m.role === 'user');
    const assistantMsg = messages.find(m => m.role === 'assistant');
    if (!userMsg || !assistantMsg) return null;

    const prompt = buildTitleGenerationPrompt(userMsg.content, assistantMsg.content);
    let title = '';
    for await (const delta of this.llmService.chatCompletion(
      [{ id: '', sessionId, role: 'user', content: prompt, createdAt: new Date() }],
      { graphContext: '', retrievedChunks: '' },
      { promptName: "title", promptVersion: "1.0.0" }
    )) {
      title += delta;
    }

    const smartTitle = title.trim().slice(0, 30);
    if (smartTitle.length > 0) {
      await this.chatStore.updateSessionTitle(sessionId, smartTitle);
    }
    return smartTitle || null;
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
    const session = await this.chatStore.getSessionById(input.sessionId);
    if (!session) {
      throw new ChatSessionNotFoundError(input.sessionId);
    }

    await this.chatStore.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.content
    });

    const analysis = await this.llmService.analyzeQuestion(input.content, {
      metadata: {
        chat_session_id: input.sessionId
      }
    });
    yield {
      type: "analysis",
      analysis
    };

    const context = await this.retrieveContext(input.content, analysis);
    await this.recordContextInjectionLogs(input.sessionId, context.accessLogEntryIds);
    const history = (await this.chatStore
      .listMessagesBySession(input.sessionId)
      ).slice(-this.options.historyLimit);

    const promptVersions = getPromptVersions();
    const routingSignals = this.buildRoutingSignals(analysis);

    if (analysis.must_use_memory && context.memoryHitCount === 0) {
      // If graph context has relevant data, don't block — let the LLM answer from graph
      const hasGraphContext = context.contextSections.graph_facts.length > 0;
      if (!hasGraphContext) {
        const fallbackAnswer = context.filteredOutMemoryCount > 0
          ? "我没有相关记忆可用于回答这个问题。我检索到的内容不属于可用身份信息（可能是低质量或无关记忆），你可以在记忆管理中修正后再问我。"
          : "我没有相关记忆可用于回答这个问题。你可以先告诉我你的相关信息。";
        yield {
          type: "delta",
          delta: fallbackAnswer
        };
        const fallbackMessage = await this.chatStore.addMessage({
          sessionId: input.sessionId,
          role: "assistant",
          content: fallbackAnswer,
          metadata: {
            prompt_versions: promptVersions,
            routing_signals: routingSignals,
            retrieval_plan: context.retrievalPlan,
            short_query_mode: context.shortQueryMode,
            conflict_detected: context.conflictDetected
          },
          sources: context.sources,
          graphContext: context.graphContext,
          sourcePaths: context.sourcePaths,
          inferredRelations: context.inferredRelations
        });
        yield {
          type: "sources",
          sources: context.sources,
          graphContext: context.graphContext,
          sourcePaths: context.sourcePaths,
          inferredRelations: context.inferredRelations
        };
        yield {
          type: "done",
          message: fallbackMessage
        };
        return;
      }
    }

    let answer = "";
    const completionOptions: {
      documentId?: string;
      promptName?: string;
      metadata?: Record<string, unknown>;
    } = {
      promptName: "chat",
      metadata: {
        chat_session_id: input.sessionId
      }
    };
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
    const assistantMessage = await this.chatStore.addMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: finalizedAnswer,
      metadata: {
        prompt_versions: promptVersions,
        routing_signals: routingSignals,
        retrieval_plan: context.retrievalPlan,
        short_query_mode: context.shortQueryMode,
        conflict_detected: context.conflictDetected
      },
      sources: context.sources,
      graphContext: context.graphContext,
      sourcePaths: context.sourcePaths,
      inferredRelations: context.inferredRelations
    });

    yield {
      type: "sources",
      sources: context.sources,
      graphContext: context.graphContext,
      sourcePaths: context.sourcePaths,
      inferredRelations: context.inferredRelations
    };
    yield {
      type: "done",
      message: assistantMessage
    };
  }

  async triggerSessionMemoryExtraction(
    sessionId: string
  ): Promise<{ sessionId: string; scanned: number; queued: number; skipped: number }> {
    const session = await this.chatStore.getSessionById(sessionId);
    if (!session) {
      throw new ChatSessionNotFoundError(sessionId);
    }
    if (!this.memoryExtractor) {
      return {
        sessionId,
        scanned: 0,
        queued: 0,
        skipped: 0
      };
    }

    const messages = await this.chatStore.listMessagesBySession(sessionId);
    const userMessages = messages.filter((message) => message.role === "user");
    let queued = 0;
    let skipped = 0;

    for (const message of userMessages) {
      const content = message.content.trim();
      if (content.length === 0) {
        skipped += 1;
        continue;
      }

      this.memoryExtractor.enqueue({
        message: content,
        sourceType: "chat_user",
        chatSessionId: sessionId,
        chatMessageId: message.id
      }).catch((error) => {
        logger.warn(
          { err: error, sessionId, chatMessageId: message.id },
          "Chat memory extraction failed (manual trigger)"
        );
      });
      queued += 1;
    }

    return {
      sessionId,
      scanned: userMessages.length,
      queued,
      skipped
    };
  }

  private async retrieveContext(
        question: string,
        analysis: QueryAnalysisV2
      ): Promise<RetrievedContext> {
        const retrievalPlan = this.calculateRetrievalPlan(question, analysis);
        const budget = retrievalPlan.sectionBudget;

        // Collect center node IDs first — shared between graph and memory retrieval
        const centerNodeIds = await this.collectCenterNodeIds(question, analysis);

        const graphContext = await this.retrieveGraphContextFromCenterNodes(centerNodeIds, analysis, retrievalPlan);
        const vectorContext = await this.retrieveVectorContext(question, analysis, retrievalPlan);
        const entryCandidates = await this.retrieveEntryVectorContext(question, analysis, retrievalPlan);

        // Retrieve memory context based on center node IDs + key_entities as fallback (§7.2)
        const memoryNodeIds = dedupeStrings([...centerNodeIds, ...analysis.key_entities]);
        const memoryContext = await this.retrieveMemoryContext(memoryNodeIds, retrievalPlan.memoryFactLimit);

        // T18: Multi-hop inference — infer implicit relations from subgraph triples
        let inferredRelations: InferredRelation[] = [];
        if (graphContext.edges.length > 0 && this.llmService.inferRelations) {
          try {
            const triples = this.buildTriplesText(graphContext.nodes, graphContext.edges);
            const rawInferred = await this.llmService.inferRelations(triples);
            inferredRelations = rawInferred.map((r) => ({
              source: r.source,
              target: r.target,
              relationType: r.relation_type,
              reasoning: r.reasoning,
              confidence: r.confidence
            }));
          } catch {
            // Inference is best-effort; don't block the response
          }
        }

        const graphContextText = this.buildGraphContextText(
          graphContext.nodes,
          graphContext.edges,
          graphContext.paths,
          inferredRelations
        );

        const rankedEntries = this.reRankEntries(
          entryCandidates.entries,
          analysis.retrieval_weights,
          analysis.conflict_policy
        );
        const scopedEntries = this.scopeEntriesByIntent(rankedEntries, analysis);
        const memoryPrimary = this.buildMemoryPrimary(scopedEntries, budget.memory_primary);
        const memorySecondary = this.buildMemorySecondary(scopedEntries, budget.memory_secondary);

        if (memoryPrimary.length === 0 && memoryContext.text.trim().length > 0) {
          const fallbackEntries = this.buildFallbackMemoryEntries(memoryContext.text, budget.memory_primary);
          const scopedFallbackEntries = this.scopeEntriesByIntent(fallbackEntries, analysis);
          memoryPrimary.push(...scopedFallbackEntries.slice(0, budget.memory_primary));
        }

        // Last-resort: for identity queries, directly fetch active manual entries from PG
        // This avoids dependency on vector similarity or Neo4j graph for simple "who am I" questions
        if (memoryPrimary.length === 0 && shouldApplyIdentityEntryScope(analysis) && this.entryStore) {
          try {
            const directResult = await this.entryStore.searchEntries({
              page: 1,
              pageSize: 20,
              sortBy: "updatedAt",
              sortOrder: "desc",
              filters: {
                states: ["active"],
                sourceTypes: ["manual", "chat_user"]
              }
            });
            const directEntries: ContextEntry[] = directResult.entries
              .filter((e) => e.reviewStatus !== "rejected" && e.reviewStatus !== "conflicted")
              .filter((e) => {
                const content = e.content.replace(/^\[CONFLICTED\]\s*/i, "").trim();
                return isIdentitySlotEntry(content) && !isLowQualityIdentityEntry(content);
              })
              .map((e) => ({
                id: e.id,
                source: toContextEntrySource(e.sourceType),
                content: trimSnippet(e.content, this.options.maxChunkContextLength),
                score: 0.95,
                updated_at: toIsoDateString(e.updatedAt)
              }));

            // Apply conflict detection so only the latest value wins
            const conflictGroups = detectEntryConflicts(directEntries);
            for (const group of conflictGroups) {
              if (group.indices.length <= 1) continue;
              const winnerIndex = resolveConflictWinner(group.indices, directEntries, analysis.conflict_policy);
              for (const index of group.indices) {
                if (winnerIndex !== null && index === winnerIndex) continue;
                directEntries[index] = {
                  ...directEntries[index]!,
                  conflict: true,
                  content: `[CONFLICTED] ${directEntries[index]!.content}`
                };
              }
            }

            const nonConflicted = directEntries.filter((e) => !e.conflict);
            memoryPrimary.push(...nonConflicted.slice(0, budget.memory_primary));
          } catch (error) {
            logger.warn({ err: error }, "Direct manual entry lookup failed");
          }
        }
        const graphFacts = this.buildGraphFacts(graphContextText, budget.graph_facts);
        const docChunks = this.buildDocChunks(vectorContext.chunks, budget.doc_chunks);
        const contextSections: ContextSections = {
          memory_primary: memoryPrimary,
          memory_secondary: memorySecondary,
          graph_facts: graphFacts,
          doc_chunks: docChunks
        };

        const combinedContextText = this.buildContextXml(contextSections);
        const accessLogEntryIds = dedupeStrings([
          ...entryCandidates.entryIds,
          ...memoryContext.entryIds,
          ...memoryPrimary.map((entry) => entry.id),
          ...memorySecondary.map((entry) => entry.id)
        ]);
        const scopedMemoryOnly = shouldUseScopedMemoryHitCount(analysis);
        const memoryHitCount = memoryPrimary.length + memorySecondary.length + (scopedMemoryOnly ? 0 : memoryContext.factCount);
        const conflictDetected = [...memoryPrimary, ...memorySecondary].some((entry) => entry.conflict === true);
        const filteredOutMemoryCount = Math.max(0, rankedEntries.length - scopedEntries.length);

        return {
          graphContextText: combinedContextText,
          retrievedChunksText: this.buildChunkContextText(docChunks, budget.doc_chunk_chars),
          sources: this.buildSourcesFromChunks(docChunks),
          graphContext: {
            nodes: graphContext.nodes.map((node) => node.id),
            edges: graphContext.edges.map((edge) => edge.id)
          },
          sourcePaths: graphContext.paths,
          inferredRelations,
          accessLogEntryIds,
          memoryHitCount,
          retrievalPlan,
          contextSections,
          shortQueryMode: budget.short_query_mode,
          conflictDetected,
          filteredOutMemoryCount
        };
      }

  private calculateRetrievalPlan(question: string, analysis: QueryAnalysisV2): RetrievalPlan {
    const baseTopK = clampInt(analysis.retrieval_strategy.vector_top_k || 5, 1, 20);
    const memoryWeight = (analysis.retrieval_weights.entry_manual + analysis.retrieval_weights.entry_chat) / 2;
    const docWeight = analysis.retrieval_weights.doc_chunks;
    const graphWeight = analysis.retrieval_weights.graph_facts;
    const memoryBias = analysis.must_use_memory ? 1.2 : 0.8;
    const sectionBudget = this.calculateSectionBudget(question, analysis);

    const entryTopK = clampInt(
      Math.round(baseTopK * (0.8 + memoryWeight * memoryBias) + sectionBudget.memory_primary + sectionBudget.memory_secondary),
      1,
      24
    );
    const vectorTopK = clampInt(
      Math.round(baseTopK * (0.6 + docWeight) + sectionBudget.doc_chunks),
      1,
      20
    );
    const memoryFactLimit = clampInt(
      Math.round(4 + memoryWeight * 8 * memoryBias + sectionBudget.memory_primary + sectionBudget.memory_secondary),
      2,
      24
    );
    const graphDepth = clampInt(
      Math.max(
        Math.round(1 + graphWeight * 3),
        analysis.retrieval_strategy.graph_depth ?? 1,
        2  // Minimum depth of 2 to support basic multi-hop reasoning
      ),
      2,
      4
    );
    const useGraph = analysis.retrieval_strategy.use_graph && graphWeight > 0.05;
    const useVector = analysis.retrieval_strategy.use_vector && docWeight > 0.05;

    return {
      graphDepth,
      vectorTopK,
      entryTopK,
      memoryFactLimit,
      useGraph,
      useVector,
      sectionBudget
    };
  }

  private buildRoutingSignals(analysis: QueryAnalysisV2): Record<string, unknown> {
    return {
      memory_intent: analysis.memory_intent,
      target_subject: analysis.target_subject,
      must_use_memory: analysis.must_use_memory,
      retrieval_weights: analysis.retrieval_weights,
      conflict_policy: analysis.conflict_policy,
      fast_path_trigger: analysis.fast_path_trigger ?? null
    };
  }

  private calculateSectionBudget(question: string, analysis: QueryAnalysisV2): SectionBudget {
    const baseTokens = 2000;
    const intent = analysis.memory_intent === "profile" ? "identity" : analysis.memory_intent;
    const intentMultipliers: Record<"identity" | "preference" | "history" | "none", {
      memory_primary: number;
      doc_chunks: number;
    }> = {
      identity: { memory_primary: 2.0, doc_chunks: 0.2 },
      preference: { memory_primary: 1.8, doc_chunks: 0.3 },
      history: { memory_primary: 1.5, doc_chunks: 0.5 },
      none: { memory_primary: 0.5, doc_chunks: 1.5 }
    };

    const multiplier = intentMultipliers[intent];
    const memoryPrimaryTokens = Math.floor(
      baseTokens * 0.4 * analysis.retrieval_weights.entry_manual * multiplier.memory_primary
    );
    const memorySecondaryTokens = Math.floor(baseTokens * 0.2 * analysis.retrieval_weights.entry_document);
    const graphFactTokens = Math.floor(baseTokens * 0.2 * analysis.retrieval_weights.graph_facts);
    const docChunkTokens = Math.floor(
      baseTokens * 0.2 * analysis.retrieval_weights.doc_chunks * multiplier.doc_chunks
    );

    const shortQueryMode =
      analysis.must_use_memory && countUserVisibleChars(question) <= 10;

    const memoryPrimaryCount = clampInt(Math.round(memoryPrimaryTokens / 110), 1, 12);
    const memorySecondaryCount = clampInt(Math.round(memorySecondaryTokens / 130), 1, 10);
    // For graph-heavy queries (relationship traversal, aggregation), ensure enough budget
    // to include both entity descriptions and relationship edges
    const graphNeedAggregation = analysis.retrieval_strategy.need_aggregation === true;
    const graphFactBase = Math.round(graphFactTokens / 160);
    const graphFactBoost = (analysis.retrieval_weights.graph_facts >= 0.7 || graphNeedAggregation)
      ? Math.max(graphFactBase, 8)
      : graphFactBase;
    const graphFactCount = clampInt(graphFactBoost, 2, 20);
    const docChunkCount = shortQueryMode
      ? 1
      : clampInt(Math.round(docChunkTokens / 180), 1, 10);

    return {
      memory_primary: memoryPrimaryCount,
      memory_secondary: memorySecondaryCount,
      graph_facts: graphFactCount,
      doc_chunks: docChunkCount,
      doc_chunk_chars: shortQueryMode ? 220 : this.options.maxChunkContextLength,
      short_query_mode: shortQueryMode
    };
  }

  private buildMemoryPrimary(entries: ContextEntry[], budget: number): ContextEntry[] {
    const primary = entries.filter((entry) => entry.source === "manual" || entry.source === "chat_user");
    return primary
      .sort(compareContextEntry)
      .slice(0, budget);
  }

  private buildMemorySecondary(entries: ContextEntry[], budget: number): ContextEntry[] {
    const secondary = entries.filter((entry) => entry.source === "document");
    return secondary
      .sort(compareContextEntry)
      .slice(0, budget);
  }

  private scopeEntriesByIntent(
    entries: ContextEntry[],
    analysis: QueryAnalysisV2
  ): ContextEntry[] {
    if (!shouldApplyIdentityEntryScope(analysis)) {
      return entries;
    }

    return entries.filter((entry) => {
      const content = stripConflictPrefix(entry.content);
      if (isLowQualityIdentityEntry(content)) {
        return false;
      }
      return isIdentitySlotEntry(content);
    });
  }

  private buildGraphFacts(graphContextText: string, budget: number): string[] {
      if (graphContextText.includes("（无图谱上下文）")) {
        return [];
      }
      const allLines = graphContextText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "));

      // Categorize lines into three tiers:
      // 1. Path lines (from "推理路径" section) — highest priority for multi-hop reasoning
      // 2. Relationship lines (contain "--[") — important for graph structure
      // 3. Entity description lines — supplementary context
      //
      // We detect path lines by checking if they contain multiple "--[" (multi-hop)
      // or appear after the "推理路径" header in the original text.
      const pathSectionStart = graphContextText.indexOf("推理路径：");
      const inferredSectionStart = graphContextText.indexOf("推断关系");
      const pathLines: string[] = [];
      const relationLines: string[] = [];
      const entityLines: string[] = [];

      for (const line of allLines) {
        const linePos = graphContextText.indexOf(line);
        const isInPathSection = pathSectionStart >= 0 && linePos > pathSectionStart
          && (inferredSectionStart < 0 || linePos < inferredSectionStart);
        const isInInferredSection = inferredSectionStart >= 0 && linePos > inferredSectionStart;

        if (isInPathSection || isInInferredSection) {
          pathLines.push(line);
        } else if (line.includes("--[")) {
          relationLines.push(line);
        } else {
          entityLines.push(line);
        }
      }

      // Budget allocation: paths first, then relationships, then entities
      const result: string[] = [];
      let remaining = budget;

      // Tier 1: reasoning paths (most valuable for multi-hop queries)
      const pathSlice = pathLines.slice(0, remaining);
      result.push(...pathSlice);
      remaining -= pathSlice.length;

      // Tier 2: relationship edges
      if (remaining > 0) {
        const relSlice = relationLines.slice(0, remaining);
        result.push(...relSlice);
        remaining -= relSlice.length;
      }

      // Tier 3: entity descriptions
      if (remaining > 0) {
        result.push(...entityLines.slice(0, remaining));
      }

      return result;
    }

  private buildDocChunks(chunks: ChunkSearchResult[], budget: number): ChunkSearchResult[] {
    if (chunks.length === 0 || budget <= 0) {
      return [];
    }
    return chunks.slice(0, budget);
  }

  private buildSourcesFromChunks(chunks: ChunkSearchResult[]): ChatSource[] {
    return chunks.map(({ chunk, score }) => {
      const source: ChatSource = {
        documentId: chunk.documentId,
        documentName: chunk.documentId,
        chunkId: chunk.id,
        relevanceScore: score,
        snippet: trimSnippet(chunk.content, this.options.maxChunkContextLength)
      };
      if (chunk.metadata.pageNumber !== undefined) {
        source.pageNumber = chunk.metadata.pageNumber;
      }
      return source;
    });
  }

  private buildFallbackMemoryEntries(memoryText: string, budget: number): ContextEntry[] {
    const lines = memoryText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .slice(0, budget);
    return lines.map((line, index) => ({
      id: `mem_fact_${index + 1}`,
      source: "chat_user",
      content: line.replace(/^- /, ""),
      score: 0.5,
      updated_at: new Date().toISOString()
    }));
  }

  private reRankEntries(
    entries: MemoryEntry[],
    weights: QueryAnalysisV2["retrieval_weights"],
    conflictPolicy: QueryAnalysisV2["conflict_policy"]
  ): ContextEntry[] {
    if (entries.length === 0) {
      return [];
    }
    const sourceWeights: Record<MemoryEntry["sourceType"], number> = {
      manual: weights.entry_manual,
      chat_user: weights.entry_chat,
      chat_assistant: weights.entry_chat * 0.8,
      document: weights.entry_document
    };
    const now = Date.now();
    const halfLife = 30 * 24 * 60 * 60 * 1000;

    const ranked: ContextEntry[] = entries.map((entry) => {
      const updatedAt = toIsoDateString(entry.updatedAt);
      const baseScore = typeof entry.similarity === "number" && Number.isFinite(entry.similarity)
        ? entry.similarity
        : 0.4;
      const sourceScore = sourceWeights[entry.sourceType] ?? 0.5;
      const ageMs = Math.max(0, now - new Date(updatedAt).getTime());
      const timeFactor = Math.exp(-ageMs / halfLife);
      const finalScore = Number((baseScore * sourceScore * (0.6 + timeFactor)).toFixed(6));
      return {
        id: entry.id,
        source: toContextEntrySource(entry.sourceType),
        content: trimSnippet(entry.content, this.options.maxChunkContextLength),
        score: finalScore,
        updated_at: updatedAt
      };
    });

    const conflictGroups = detectEntryConflicts(ranked);
    for (const group of conflictGroups) {
      if (group.indices.length <= 1) {
        continue;
      }
      const winnerIndex = resolveConflictWinner(group.indices, ranked, conflictPolicy);
      for (const index of group.indices) {
        if (winnerIndex !== null && index === winnerIndex) {
          continue;
        }
        ranked[index] = {
          ...ranked[index]!,
          conflict: true,
          content: ranked[index]!.content.startsWith("[CONFLICTED]")
            ? ranked[index]!.content
            : `[CONFLICTED] ${ranked[index]!.content}`
        };
      }
    }

    return ranked.sort(compareContextEntry);
  }

  private buildContextXml(sections: ContextSections): string {
    const renderEntry = (entry: ContextEntry): string => {
      const attrs = [
        `id="${escapeXml(entry.id)}"`,
        `source="${escapeXml(entry.source)}"`,
        `score="${entry.score.toFixed(4)}"`,
        `updated_at="${escapeXml(entry.updated_at)}"`
      ];
      if (entry.conflict) {
        attrs.push(`conflict="true"`);
      }
      return `    <entry ${attrs.join(" ")}>${escapeXml(entry.content)}</entry>`;
    };
    const renderGraphFact = (line: string, index: number): string => {
      const id = `graph_${index + 1}`;
      return `    <fact id="${id}">${escapeXml(line.replace(/^- /, ""))}</fact>`;
    };
    const renderChunk = ({ chunk, score }: ChunkSearchResult, index: number): string => {
      const id = `doc_${index + 1}`;
      const attrs = [
        `id="${id}"`,
        `document_id="${escapeXml(chunk.documentId)}"`,
        `chunk_id="${escapeXml(chunk.id)}"`,
        `score="${score.toFixed(4)}"`
      ];
      return `    <chunk ${attrs.join(" ")}>${escapeXml(trimSnippet(chunk.content, this.options.maxChunkContextLength))}</chunk>`;
    };

    return [
      "<context>",
      "  <memory_primary>",
      ...sections.memory_primary.map(renderEntry),
      "  </memory_primary>",
      "  <memory_secondary>",
      ...sections.memory_secondary.map(renderEntry),
      "  </memory_secondary>",
      "  <graph_facts>",
      ...sections.graph_facts.map(renderGraphFact),
      "  </graph_facts>",
      "  <doc_chunks>",
      ...sections.doc_chunks.map(renderChunk),
      "  </doc_chunks>",
      "</context>"
    ].join("\n");
  }

  private async retrieveGraphContext(
        question: string,
        analysis: QueryAnalysisV2
      ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; paths: SourcePath[] }> {
        const retrievalPlan = this.calculateRetrievalPlan(question, analysis);
        if (!retrievalPlan.useGraph) {
          return { nodes: [], edges: [], paths: [] };
        }

        const centerNodeIds = await this.collectCenterNodeIds(question, analysis);
        return this.retrieveGraphContextFromCenterNodes(centerNodeIds, analysis, retrievalPlan);
      }

  private async retrieveGraphContextFromCenterNodes(
        centerNodeIds: string[],
        analysis: QueryAnalysisV2,
        retrievalPlan: RetrievalPlan
      ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; paths: SourcePath[] }> {
        if (!retrievalPlan.useGraph || centerNodeIds.length === 0) {
          return { nodes: [], edges: [], paths: [] };
        }

        const maxDepth = clampInt(retrievalPlan.graphDepth, 1, 4);
        const graphWeight = analysis.retrieval_weights.graph_facts;
        const maxNodes = Math.max(30, Math.floor(this.options.maxGraphContextNodes * (1 + graphWeight * 2)));
        const maxEdges = Math.max(40, Math.floor(this.options.maxGraphContextEdges * (1 + graphWeight * 2)));

        logger.info(
          { centerNodeIds, maxDepth, maxNodes, maxEdges, graphWeight, graphDepth: retrievalPlan.graphDepth },
          "Graph retrieval params"
        );

        const subgraph = await this.graphStore.getSubgraph({
          centerNodeIds,
          maxDepth,
          maxNodes
        });

        logger.info(
          {
            subgraphNodeCount: subgraph.nodes.length,
            subgraphEdgeCount: subgraph.edges.length,
            subgraphNodeNames: subgraph.nodes.map((n) => n.name).slice(0, 20),
            subgraphEdgeTypes: subgraph.edges.map((e) => `${e.sourceNodeId.slice(0, 8)}→${e.targetNodeId.slice(0, 8)}(${e.relationType})`).slice(0, 20)
          },
          "Graph subgraph retrieved"
        );

        const nodes = subgraph.nodes.slice(0, this.options.maxGraphContextNodes);
        const allowedNodeIds = new Set(nodes.map((node) => node.id));
        const edges = subgraph.edges
          .filter(
            (edge) =>
              allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId)
          )
          .slice(0, maxEdges);

        const paths = buildTopPaths(nodes, edges, centerNodeIds);

        return { nodes, edges, paths };
      }

  private async collectCenterNodeIds(
      question: string,
      analysis: QueryAnalysisV2
    ): Promise<string[]> {
      const keyEntities = analysis.key_entities.filter((e) => e.trim().length > 0);
      // Search key_entities first (highest precision), then rewritten_query and
      // original question as fallback.  Dedupe so we don't search the same text
      // twice.
      const primaryCandidates = dedupeStrings(keyEntities);
      const secondaryCandidates = dedupeStrings([
        analysis.rewritten_query,
        question
      ]).filter((c) => !primaryCandidates.includes(c));

      const primaryHits: SearchResult[] = [];
      const secondaryHits: SearchResult[] = [];

      for (const candidate of primaryCandidates.slice(0, 4)) {
        const results = await this.graphStore.searchNodes(
          candidate,
          this.options.entitySearchLimit
        );
        primaryHits.push(...results);
      }

      // Only search secondary candidates if primary didn't find enough nodes
      if (primaryHits.length < 2) {
        for (const candidate of secondaryCandidates.slice(0, 3)) {
          const results = await this.graphStore.searchNodes(
            candidate,
            this.options.entitySearchLimit
          );
          secondaryHits.push(...results);
        }
      }

      // Primary hits get priority; apply a minimum score threshold to secondary
      // hits to avoid pulling in unrelated nodes from broad query strings.
      const MIN_SECONDARY_SCORE = 1.0;
      const filteredSecondary = secondaryHits.filter((h) => h.score >= MIN_SECONDARY_SCORE);

      const combined = [...primaryHits, ...filteredSecondary]
        .sort((a, b) => b.score - a.score);

      // Limit center nodes to avoid BFS explosion from noisy seeds
      const maxCenterNodes = keyEntities.length <= 2 ? 4 : 6;
      return dedupeStrings(combined.map((item) => item.node.id)).slice(0, maxCenterNodes);
    }

  private async retrieveVectorContext(
    question: string,
    analysis: QueryAnalysisV2,
    retrievalPlan: RetrievalPlan
  ): Promise<{ chunks: ChunkSearchResult[] }> {
    if (!retrievalPlan.useVector) {
      return { chunks: [] };
    }
    if (!this.chunkContextStore) {
      return { chunks: [] };
    }

    const embeddingInput = analysis.rewritten_query.trim().length > 0
      ? analysis.rewritten_query
      : question;
    const vector = await this.generateEmbeddingWithFallback(embeddingInput);
    if (vector.length === 0) {
      return { chunks: [] };
    }

    const topK = clampInt(retrievalPlan.vectorTopK, 1, 20);
    const chunks = await this.chunkContextStore.chunkVectorSearch(vector, topK);
    return { chunks };
  }

  private async retrieveEntryVectorContext(
    question: string,
    analysis: QueryAnalysisV2,
    retrievalPlan: RetrievalPlan
  ): Promise<{ entries: MemoryEntry[]; entryIds: string[] }> {
    if (!this.entryStore) {
      return { entries: [], entryIds: [] };
    }

    const embeddingInput = analysis.rewritten_query.trim().length > 0
      ? analysis.rewritten_query
      : question;
    const vector = await this.generateEmbeddingWithFallback(embeddingInput);
    if (vector.length === 0) {
      return { entries: [], entryIds: [] };
    }

    try {
      const requestedTopK = retrievalPlan.entryTopK;
      const topK = clampInt(requestedTopK, 1, 20);
      let semanticEntries: MemoryEntry[] = [];
      try {
        semanticEntries = await this.entryStore.searchEntriesByVector(vector, Math.max(topK, 8));
      } catch (error) {
        logger.warn({ err: error }, "Entry vector retrieval failed, fallback retrieval will be used");
      }
      const fallbackEntries = await this.retrieveEntryFallbackByText(embeddingInput, Math.max(topK, 8));
      const entries = mergeEntryCandidates(semanticEntries, fallbackEntries, topK);
      if (entries.length === 0) {
        return { entries: [], entryIds: [] };
      }
      return {
        entries,
        entryIds: entries.map((entry) => entry.id)
      };
    } catch (error) {
      logger.warn({ err: error }, "Entry vector retrieval failed, continuing without entry context");
      return { entries: [], entryIds: [] };
    }
  }

  private async generateEmbeddingWithFallback(text: string): Promise<number[]> {
    try {
      const embedding = await this.llmService.generateEmbedding(text);
      if (
        Array.isArray(embedding)
        && embedding.length === appConfig.EMBEDDING_DIMENSIONS
        && embedding.every((value) => Number.isFinite(value))
      ) {
        return embedding;
      }
    } catch (error) {
      logger.warn({ err: error }, "LLM embedding failed, fallback embedding will be used");
    }

    return buildFallbackTextEmbedding(text);
  }

  private async retrieveEntryFallbackByText(query: string, limit: number): Promise<MemoryEntry[]> {
    if (!this.entryStore) {
      return [];
    }

    const queryEmbedding = buildFallbackTextEmbedding(query);
    if (queryEmbedding.length === 0) {
      return [];
    }

    try {
      const result = await this.entryStore.searchEntries({
        page: 1,
        pageSize: 200,
        sortBy: "updatedAt",
        sortOrder: "desc",
        filters: {
          states: ["active"]
        }
      });

      const scored = result.entries
        .filter((entry) => entry.reviewStatus !== "rejected")
        .map((entry) => {
          const entryEmbedding = buildFallbackTextEmbedding(entry.content);
          const similarity = cosineSimilarity(queryEmbedding, entryEmbedding);
          return { entry, similarity };
        })
        .filter((item) => item.similarity > 0)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, limit);

      return scored.map(({ entry, similarity }) => ({
        ...entry,
        similarity
      }));
    } catch (error) {
      logger.warn({ err: error }, "Entry fallback retrieval failed");
      return [];
    }
  }

  /**
   * Retrieve relevant memory facts for the given node IDs.
   * Returns formatted memory context text, or empty string if no memory service.
   */
  private async retrieveMemoryContext(
    nodeIds: string[],
    limit: number
  ): Promise<{ text: string; entryIds: string[]; factCount: number }> {
    if (!this.memoryService || nodeIds.length === 0) {
      return { text: "", entryIds: [], factCount: 0 };
    }

    try {
      const facts = this.memoryService.retrieveRelevant(nodeIds, limit);
      if (facts.length === 0) {
        return { text: "", entryIds: [], factCount: 0 };
      }
      return {
        text: this.memoryService.buildMemoryContextText(facts),
        entryIds: facts
          .map((fact) => fact.entryId ?? "")
          .filter((entryId) => entryId.trim().length > 0),
        factCount: facts.length
      };
    } catch (error) {
      logger.warn({ err: error }, "Memory context retrieval failed, continuing without memory");
      return { text: "", entryIds: [], factCount: 0 };
    }
  }

  private async recordContextInjectionLogs(sessionId: string, entryIds: string[]): Promise<void> {
    if (!this.recordEntryAccessLogs) {
      return;
    }
    const deduped = dedupeStrings(entryIds);
    if (deduped.length === 0) {
      return;
    }

    try {
      await this.recordEntryAccessLogs({
        entryIds: deduped,
        chatSessionId: sessionId,
        accessType: "context_injection"
      });
    } catch (error) {
      logger.warn({ err: error, sessionId, entryCount: deduped.length }, "Failed to record context injection access logs");
    }
  }

  private buildGraphContextText(
        nodes: GraphNode[],
        edges: GraphEdge[],
        paths: SourcePath[] = [],
        inferredRelations: InferredRelation[] = []
      ): string {
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
          return `- ${sourceName} --[${edge.relationType}]--> ${targetName}`;
        });

        const sections = [
          "实体：",
          ...nodeLines,
          "",
          "关系：",
          ...edgeLines
        ];

        if (paths.length > 0) {
          sections.push("", "推理路径：");
          for (const path of paths) {
            const parts: string[] = [];
            for (let i = 0; i < path.nodes.length; i++) {
              parts.push(path.nodes[i]!);
              if (i < path.relations.length) {
                parts.push(`--[${path.relations[i]}]-->`);
              }
            }
            sections.push(`- ${parts.join(" ")}`);
          }
        }

        if (inferredRelations.length > 0) {
          sections.push("", "推断关系（LLM 推断，非显式记录）：");
          for (const rel of inferredRelations) {
            sections.push(
              `- ${rel.source} --[${rel.relationType}]--> ${rel.target} (置信度: ${rel.confidence.toFixed(2)}, 依据: ${rel.reasoning})`
            );
          }
        }

        return sections.join("\n");
      }

  private buildTriplesText(nodes: GraphNode[], edges: GraphEdge[]): string {
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const lines: string[] = [];
    for (const edge of edges) {
      const sourceName = nodeById.get(edge.sourceNodeId)?.name ?? edge.sourceNodeId;
      const targetName = nodeById.get(edge.targetNodeId)?.name ?? edge.targetNodeId;
      lines.push(`${sourceName} --[${edge.relationType}]--> ${targetName}`);
    }
    return lines.join("\n");
  }

  private buildChunkContextText(chunks: ChunkSearchResult[], maxLength: number): string {
    if (chunks.length === 0) {
      return "（无文档片段）";
    }

    return chunks
      .map(({ chunk, score }, index) => {
        const snippet = trimSnippet(chunk.content, maxLength);
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

function mergeEntryCandidates(
  primary: MemoryEntry[],
  fallback: MemoryEntry[],
  limit: number
): MemoryEntry[] {
  const merged = new Map<string, { entry: MemoryEntry; score: number }>();

  const upsert = (entry: MemoryEntry): void => {
    const base = typeof entry.similarity === "number" && Number.isFinite(entry.similarity)
      ? entry.similarity
      : 0;
    const sourceBoost = entry.sourceType === "manual"
      ? 0.08
      : (entry.sourceType === "chat_user" ? 0.05 : (entry.sourceType === "chat_assistant" ? 0.04 : 0));
    const score = base + sourceBoost;
    const existing = merged.get(entry.id);
    if (!existing || score > existing.score) {
      merged.set(entry.id, { entry, score });
    }
  };

  for (const entry of primary) {
    upsert(entry);
  }
  for (const entry of fallback) {
    upsert(entry);
  }

  return [...merged.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
    })
    .slice(0, limit)
    .map(({ entry, score }) => ({
      ...entry,
      similarity: Number(score.toFixed(4))
    }));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const lv = left[index] ?? 0;
    const rv = right[index] ?? 0;
    dot += lv * rv;
    leftNorm += lv * lv;
    rightNorm += rv * rv;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function toContextEntrySource(sourceType: MemoryEntry["sourceType"]): ContextEntry["source"] {
  if (sourceType === "manual" || sourceType === "chat_user" || sourceType === "document") {
    return sourceType;
  }
  return "chat_user";
}

function compareContextEntry(left: ContextEntry, right: ContextEntry): number {
  const leftConflict = left.conflict ? 1 : 0;
  const rightConflict = right.conflict ? 1 : 0;
  if (leftConflict !== rightConflict) {
    return leftConflict - rightConflict;
  }
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return right.updated_at.localeCompare(left.updated_at);
}

function shouldApplyIdentityEntryScope(analysis: QueryAnalysisV2): boolean {
  if (analysis.target_subject !== "user_self") {
    return false;
  }
  return analysis.memory_intent === "identity";
}

function shouldUseScopedMemoryHitCount(analysis: QueryAnalysisV2): boolean {
  return shouldApplyIdentityEntryScope(analysis);
}

function stripConflictPrefix(content: string): string {
  return content.replace(/^\[CONFLICTED\]\s*/i, "").trim();
}

function isIdentitySlotEntry(content: string): boolean {
  const compact = content.replace(/\s+/g, "");
  if (/用户(?:的)?(?:姓名|名字|身份|职业|职位|工作|来源地|家乡|籍贯|居住地)/.test(compact)) {
    return true;
  }
  if (/用户(?:是|叫|名叫|来自)/.test(compact)) {
    return true;
  }
  // Match first-person identity patterns from manual entries
  if (/我(?:是|叫|名叫|来自)/.test(compact)) {
    return true;
  }
  if (/我(?:的)?(?:姓名|名字|身份|职业|职位|工作|来源地|家乡|籍贯|居住地)/.test(compact)) {
    return true;
  }
  return false;
}

function isLowQualityIdentityEntry(content: string): boolean {
  const compact = content.replace(/\s+/g, "");
  return /(你爹|你爸|你爸爸|你爷|你爷爷|你祖宗|你妈|你娘|废物|傻逼|煞笔|脑残|白痴|弱智|狗东西|畜生)/i.test(compact);
}

function detectEntryConflicts(entries: ContextEntry[]): Array<{ key: string; indices: number[] }> {
  const groups = new Map<string, { indices: number[]; objects: Set<string> }>();

  entries.forEach((entry, index) => {
    const parsed = parseMemoryContent(entry.content);
    if (!parsed) {
      return;
    }
    const key = `${normalizeLoose(parsed.subject)}|${normalizeLoose(parsed.predicate)}`;
    const object = normalizeLoose(parsed.object);
    const current = groups.get(key) ?? { indices: [], objects: new Set<string>() };
    current.indices.push(index);
    current.objects.add(object);
    groups.set(key, current);
  });

  const conflicts: Array<{ key: string; indices: number[] }> = [];
  for (const [key, group] of groups.entries()) {
    if (group.indices.length > 1 && group.objects.size > 1) {
      conflicts.push({ key, indices: group.indices });
    }
  }
  return conflicts;
}

function resolveConflictWinner(
  indices: number[],
  entries: ContextEntry[],
  policy: QueryAnalysisV2["conflict_policy"]
): number | null {
  if (policy === "abstain") {
    return null;
  }

  let winner = indices[0] ?? null;
  for (const index of indices) {
    if (winner === null) {
      winner = index;
      continue;
    }
    const candidate = entries[index]!;
    const current = entries[winner]!;
    if (policy === "highest_confidence_wins") {
      if (candidate.score > current.score) {
        winner = index;
      }
      continue;
    }
    // latest_manual_wins
    const candidateManualPriority = candidate.source === "manual" ? 1 : 0;
    const currentManualPriority = current.source === "manual" ? 1 : 0;
    if (candidateManualPriority !== currentManualPriority) {
      if (candidateManualPriority > currentManualPriority) {
        winner = index;
      }
      continue;
    }
    if (candidate.updated_at > current.updated_at) {
      winner = index;
    }
  }
  return winner;
}

function parseMemoryContent(content: string): { subject: string; predicate: string; object: string } | null {
  const normalized = content.replace(/\[CONFLICTED\]\s*/g, "").replace(/\s+/g, "");
  // Match "用户(的)X是Y" pattern
  let match = normalized.match(/用户(?:的)?(.{1,12})是([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: match[1] ?? "",
      object: match[2] ?? ""
    };
  }
  // Match first-person "我叫/我是/我的X是" patterns (manual entries often use first-person)
  match = normalized.match(/我(?:叫|名叫)([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "姓名",
      object: match[1] ?? ""
    };
  }
  match = normalized.match(/我(?:的)?(?:名字|姓名)(?:是|叫)([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "姓名",
      object: match[1] ?? ""
    };
  }
  match = normalized.match(/我是(?:一[名个位])?([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "身份",
      object: match[1] ?? ""
    };
  }
  // Match "用户叫/名叫X" pattern
  match = normalized.match(/用户(?:叫|名叫)([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "姓名",
      object: match[1] ?? ""
    };
  }
  match = normalized.match(/用户喜欢([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "喜欢",
      object: match[1] ?? ""
    };
  }
  match = normalized.match(/用户不喜欢([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "不喜欢",
      object: match[1] ?? ""
    };
  }
  // Match first-person preference patterns
  match = normalized.match(/我喜欢([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "喜欢",
      object: match[1] ?? ""
    };
  }
  match = normalized.match(/我不喜欢([^，。；;]+)/);
  if (match) {
    return {
      subject: "用户",
      predicate: "不喜欢",
      object: match[1] ?? ""
    };
  }
  return null;
}

function normalizeLoose(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

function countUserVisibleChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function toIsoDateString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return String(value ?? "");
}

function escapeXml(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * T9: Build ordered paths from seed nodes through edges.
 * Produces human-readable path strings like: A --[works_for]--> B --[located_in]--> C
 */
function buildTopPaths(
  nodes: GraphNode[],
  edges: GraphEdge[],
  seedNodeIds: string[],
  maxPaths = 10
): SourcePath[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Build bidirectional adjacency — graph edges are directed but we need
  // to traverse in both directions for multi-hop path discovery.
  const adjacency = new Map<string, { targetId: string; relationType: string }[]>();

  const addAdj = (fromId: string, toId: string, relationType: string): void => {
    const list = adjacency.get(fromId) ?? [];
    list.push({ targetId: toId, relationType });
    adjacency.set(fromId, list);
  };

  for (const edge of edges) {
    addAdj(edge.sourceNodeId, edge.targetNodeId, edge.relationType);
    addAdj(edge.targetNodeId, edge.sourceNodeId, edge.relationType);
  }

  const paths: SourcePath[] = [];
  const seedSet = new Set(seedNodeIds);

  for (const seedId of seedNodeIds) {
    if (paths.length >= maxPaths) break;
    const seedNode = nodeById.get(seedId);
    if (!seedNode) continue;

    const neighbors = adjacency.get(seedId) ?? [];
    for (const hop1 of neighbors) {
      if (paths.length >= maxPaths) break;
      const hop1Node = nodeById.get(hop1.targetId);
      if (!hop1Node) continue;

      // Try extending to 2-hop
      const hop2Neighbors = adjacency.get(hop1.targetId) ?? [];
      const hop2 = hop2Neighbors.find(
        (h) => !seedSet.has(h.targetId) && h.targetId !== seedId && nodeById.has(h.targetId)
      );

      if (hop2) {
        const hop2Node = nodeById.get(hop2.targetId);
        if (hop2Node) {
          paths.push({
            nodes: [seedNode.name, hop1Node.name, hop2Node.name],
            relations: [hop1.relationType, hop2.relationType]
          });
          continue;
        }
      }

      paths.push({
        nodes: [seedNode.name, hop1Node.name],
        relations: [hop1.relationType]
      });
    }
  }

  return paths;
}
