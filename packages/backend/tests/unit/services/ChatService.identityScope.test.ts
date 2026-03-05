import type { MemoryEntry, MemoryEntryStoreLike } from "@graphen/shared";
import { describe, expect, it } from "vitest";
import { InMemoryChatStore } from "../../../src/services/InMemoryChatStore.js";
import { ChatService } from "../../../src/services/ChatService.js";
import type {
  ExtractionResult,
  LLMRequestOptions,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext
} from "../../../src/services/llmTypes.js";
import { FakeGraphStore } from "../../helpers/FakeGraphStore.js";

class IdentityScopeLLM implements LLMServiceLike {
  constructor(private readonly analysis: QuestionAnalysis) {}

  async extractEntitiesAndRelations(
    _text: string,
    _schema?: unknown,
    _options?: LLMRequestOptions
  ): Promise<ExtractionResult> {
    return { entities: [], relations: [] };
  }

  async *chatCompletion(
    _messages: Array<{ role: string; content: string }>,
    context: RAGContext
  ): AsyncGenerator<string> {
    // Echo injected XML context so tests can assert memory section composition.
    yield context.graphContext;
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3, 0.4];
  }

  async analyzeQuestion(_question: string): Promise<QuestionAnalysis> {
    return this.analysis;
  }
}

describe("ChatService identity scope filtering", () => {
  it("keeps identity-slot memory and drops low-quality provocation entries", async () => {
    const entryStore = createEntryStore([
      buildEntry("mem-valid", "用户的名字是李雷，职业是产品经理。", "2026-03-04T10:00:00.000Z", 0.91),
      buildEntry("mem-noise", "用户的身份是你爹。", "2026-03-04T10:01:00.000Z", 0.93)
    ]);
    const service = createChatService(entryStore, buildIdentityAnalysis());

    const session = await service.createSession({ title: "identity scope" });
    const message = await service.completeMessage({
      sessionId: session.id,
      content: "我是谁？"
    });

    expect(message.content).toContain("李雷");
    expect(message.content).toContain("产品经理");
    expect(message.content).not.toContain("你爹");
  });

  it("returns memory-miss fallback when identity memories are all low quality", async () => {
    const entryStore = createEntryStore([
      buildEntry("mem-noise-only", "用户的身份是你爹。", "2026-03-04T10:01:00.000Z", 0.95)
    ]);
    const service = createChatService(entryStore, buildIdentityAnalysis());

    const session = await service.createSession({ title: "identity fallback" });
    const message = await service.completeMessage({
      sessionId: session.id,
      content: "我是谁？"
    });

    expect(message.content).toContain("我没有相关记忆可用于回答这个问题");
    expect(message.content).not.toContain("你爹");
  });
});

function createChatService(
  entryStore: MemoryEntryStoreLike,
  analysis: QuestionAnalysis
): ChatService {
  const graphStore = new FakeGraphStore();
  const chatStore = new InMemoryChatStore();
  const llmService = new IdentityScopeLLM(analysis);
  return new ChatService(graphStore, chatStore, llmService, {}, { entryStore });
}

function createEntryStore(entries: MemoryEntry[]): MemoryEntryStoreLike {
  return {
    searchEntriesByVector: async () => entries,
    searchEntries: async () => ({
      entries,
      total: entries.length,
      page: 1,
      pageSize: Math.max(1, entries.length)
    })
  } as unknown as MemoryEntryStoreLike;
}

function buildIdentityAnalysis(): QuestionAnalysis {
  return {
    intent: "factual",
    key_entities: ["用户"],
    retrieval_strategy: {
      use_graph: false,
      use_vector: true,
      graph_depth: 1,
      vector_top_k: 4,
      need_aggregation: false
    },
    rewritten_query: "用户身份信息",
    memory_intent: "identity",
    target_subject: "user_self",
    must_use_memory: true,
    retrieval_weights: {
      entry_manual: 1,
      entry_chat: 0.8,
      entry_document: 0.1,
      graph_facts: 0.1,
      doc_chunks: 0.1
    },
    conflict_policy: "latest_manual_wins",
    fast_path_trigger: "identity_self"
  };
}

function buildEntry(
  id: string,
  content: string,
  updatedAt: string,
  similarity: number
): MemoryEntry {
  return {
    id,
    content,
    normalizedContentKey: content.trim().toLowerCase(),
    state: "active",
    reviewStatus: "auto",
    categories: [],
    sourceType: "manual",
    firstSeenAt: updatedAt,
    lastSeenAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
    similarity
  };
}
