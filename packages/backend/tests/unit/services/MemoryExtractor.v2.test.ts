import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  MemoryEntryFact,
  MemoryEntryStoreLike,
  MemoryEntryUpsertFactInput,
  MemoryServiceLike
} from "@graphen/shared";
import { describe, expect, it, vi } from "vitest";
import { MemoryExtractor } from "../../../src/services/MemoryExtractor.js";
import type {
  ExtractionResult,
  LLMRequestOptions,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext
} from "../../../src/services/llmTypes.js";

interface ExtractionResponsePayload {
  should_store?: boolean;
  entry_summary?: string;
  facts?: Array<{
    subject: string;
    predicate: string;
    object: string;
    valueType?: "entity" | "text" | "number" | "date";
    confidence?: number;
  }>;
  rejection_reason?: string;
}

class MemoryExtractionFakeLLM implements LLMServiceLike {
  constructor(private readonly responses: Map<string, ExtractionResponsePayload>) {}

  async extractEntitiesAndRelations(
    _text: string,
    _schema?: unknown,
    _options?: LLMRequestOptions
  ): Promise<ExtractionResult> {
    return { entities: [], relations: [] };
  }

  async *chatCompletion(
    messages: Array<{ content: string }>,
    _context: RAGContext
  ): AsyncGenerator<string> {
    const prompt = messages[0]?.content ?? "";
    const message = extractMessageFromPrompt(prompt);
    const payload = this.responses.get(message) ?? {
      should_store: false,
      entry_summary: "",
      facts: [],
      rejection_reason: "未命中测试桩"
    };
    yield JSON.stringify(payload);
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3, 0.4];
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
      rewritten_query: "用户信息",
      memory_intent: "profile",
      target_subject: "user_self",
      must_use_memory: true,
      retrieval_weights: {
        entry_manual: 1,
        entry_chat: 0.8,
        entry_document: 0.1,
        graph_facts: 0.1,
        doc_chunks: 0.1
      },
      conflict_policy: "latest_manual_wins"
    };
  }
}

function createMemoryServiceMock() {
  const createEntry = vi.fn(async (content: string): Promise<MemoryEntry> => buildEntry(content));
  const memoryService: MemoryServiceLike = {
    mergeFacts: () => ({ created: 0, updated: 0, conflicted: 0 }),
    reviewFact: () => null,
    retrieveRelevant: () => [],
    buildMemoryContextText: () => "",
    createEntry,
    updateEntry: async () => null,
    getEntryWithFacts: async () => null
  };
  return { memoryService, createEntry };
}

function createEntryStoreMock() {
  const upsertFacts = vi.fn(
    async (entryId: string, facts: MemoryEntryUpsertFactInput[]): Promise<{ created: number; updated: number; facts: MemoryEntryFact[] }> => ({
      created: facts.length > 0 ? 1 : 0,
      updated: 0,
      facts: facts.map((fact, index) => buildEntryFact(entryId, index, fact))
    })
  );

  const entryStore = {
    upsertFacts
  } as unknown as MemoryEntryStoreLike;

  return { entryStore, upsertFacts };
}

describe("MemoryExtractor v2", () => {
  it.each([
    {
      message: "我是谁？",
      reason: "问句",
      payload: {
        should_store: false,
        entry_summary: "",
        facts: [],
        rejection_reason: "这是一个问句，不包含新的事实信息"
      }
    },
    {
      message: "你好，很高兴认识你！",
      reason: "寒暄",
      payload: {
        should_store: false,
        entry_summary: "",
        facts: [],
        rejection_reason: "这是寒暄语，不包含值得长期保存的信息"
      }
    },
    {
      message: "好的",
      reason: "无信息",
      payload: {
        should_store: false,
        entry_summary: "",
        facts: [],
        rejection_reason: "无信息短句，不应入库"
      }
    }
  ])("rejects non-memory messages: $reason", async ({ message, payload }) => {
    const llm = new MemoryExtractionFakeLLM(new Map([[message, payload]]));
    const { memoryService, createEntry } = createMemoryServiceMock();
    const { entryStore, upsertFacts } = createEntryStoreMock();
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });

    const result = await extractor.enqueue({
      message,
      sourceType: "chat_user"
    });

    expect(result).toEqual({ created: 0, updated: 0, conflicted: 0 });
    expect(createEntry).not.toHaveBeenCalled();
    expect(upsertFacts).not.toHaveBeenCalled();
  });

  it("stores first-person identity statements with normalized subject/predicate", async () => {
    const message = "我是张三，是一名软件工程师。";
    const llm = new MemoryExtractionFakeLLM(
      new Map([
        [
          message,
          {
            should_store: true,
            entry_summary: "用户的姓名是张三，职业是软件工程师",
            facts: [
              {
                subject: "我",
                predicate: "我叫",
                object: "张三",
                valueType: "text",
                confidence: 0.95
              }
            ],
            rejection_reason: ""
          }
        ]
      ])
    );
    const { memoryService, createEntry } = createMemoryServiceMock();
    const { entryStore, upsertFacts } = createEntryStoreMock();
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });

    const result = await extractor.enqueue({
      message,
      sourceType: "chat_user"
    });

    expect(result.created).toBe(1);
    expect(createEntry).toHaveBeenCalledWith("用户的姓名是张三，职业是软件工程师", expect.anything());
    const [, upsertInput] = upsertFacts.mock.calls[0] as [string, MemoryEntryUpsertFactInput[]];
    expect(upsertInput[0]?.subjectText).toBe("用户");
    expect(upsertInput[0]?.predicate).toBe("姓名");
    expect(upsertInput[0]?.objectText).toBe("张三");
  });

  it("rejects low-quality identity provocations even when should_store=true", async () => {
    const message = "我是你爹。";
    const llm = new MemoryExtractionFakeLLM(
      new Map([
        [
          message,
          {
            should_store: true,
            entry_summary: "用户的身份是你爹",
            facts: [
              {
                subject: "我",
                predicate: "身份",
                object: "你爹",
                valueType: "text",
                confidence: 0.97
              }
            ],
            rejection_reason: ""
          }
        ]
      ])
    );
    const { memoryService, createEntry } = createMemoryServiceMock();
    const { entryStore, upsertFacts } = createEntryStoreMock();
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });

    const result = await extractor.enqueue({
      message,
      sourceType: "chat_user"
    });

    expect(result).toEqual({ created: 0, updated: 0, conflicted: 0 });
    expect(createEntry).not.toHaveBeenCalled();
    expect(upsertFacts).not.toHaveBeenCalled();
  });

  it("stores first-person preference statements with normalized predicate", async () => {
    const message = "我喜欢咖啡。";
    const llm = new MemoryExtractionFakeLLM(
      new Map([
        [
          message,
          {
            should_store: true,
            entry_summary: "用户偏好咖啡",
            facts: [
              {
                subject: "我",
                predicate: "喜欢",
                object: "咖啡",
                valueType: "text",
                confidence: 0.92
              }
            ],
            rejection_reason: ""
          }
        ]
      ])
    );
    const { memoryService } = createMemoryServiceMock();
    const { entryStore, upsertFacts } = createEntryStoreMock();
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });

    const result = await extractor.enqueue({
      message,
      sourceType: "chat_user"
    });

    expect(result.created).toBe(1);
    const [, upsertInput] = upsertFacts.mock.calls[0] as [string, MemoryEntryUpsertFactInput[]];
    expect(upsertInput[0]?.subjectText).toBe("用户");
    expect(upsertInput[0]?.predicate).toBe("偏好");
    expect(upsertInput[0]?.objectText).toBe("咖啡");
  });

  it("keeps backward compatibility when old schema only contains facts[]", async () => {
    const message = "我来自上海。";
    const llm = new MemoryExtractionFakeLLM(
      new Map([
        [
          message,
          {
            facts: [
              {
                subject: "我",
                predicate: "来自",
                object: "上海",
                valueType: "text",
                confidence: 0.9
              }
            ]
          }
        ]
      ])
    );
    const { memoryService, createEntry } = createMemoryServiceMock();
    const { entryStore } = createEntryStoreMock();
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });

    const result = await extractor.enqueue({
      message,
      sourceType: "chat_user"
    });

    expect(result.created).toBe(1);
    expect(createEntry).toHaveBeenCalledWith(message, expect.anything());
  });
});

function extractMessageFromPrompt(prompt: string): string {
  const marker = "请从以下消息中提取事实：";
  const index = prompt.indexOf(marker);
  if (index < 0) {
    return prompt.trim();
  }
  return prompt.slice(index + marker.length).trim();
}

function buildEntry(content: string): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    content,
    normalizedContentKey: content.trim().toLowerCase(),
    state: "active",
    reviewStatus: "auto",
    categories: [],
    sourceType: "chat_user",
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function buildEntryFact(
  entryId: string,
  index: number,
  input: MemoryEntryUpsertFactInput
): MemoryEntryFact {
  const now = new Date().toISOString();
  return {
    id: `fact-${index + 1}`,
    entryId,
    subjectNodeId: input.subjectNodeId,
    subjectText: input.subjectText ?? "",
    predicate: input.predicate,
    objectNodeId: input.objectNodeId,
    objectText: input.objectText,
    valueType: input.valueType ?? "text",
    normalizedFactKey: `${input.subjectText ?? ""}|${input.predicate}|${input.objectText ?? ""}`.toLowerCase(),
    confidence: input.confidence ?? 0.8,
    factState: input.factState ?? "active",
    createdAt: now,
    updatedAt: now,
    neo4jSynced: false,
    neo4jRetryCount: 0
  };
}
