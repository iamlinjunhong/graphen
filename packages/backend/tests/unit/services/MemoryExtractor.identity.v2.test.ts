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

interface IdentityCase {
  id: string;
  message: string;
  subject: string;
  predicate: string;
  object: string;
  expectedPredicate: string;
}

class IdentityExtractionFakeLLM implements LLMServiceLike {
  constructor(private readonly cases: Map<string, IdentityCase>) {}

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
    const item = this.cases.get(message);
    if (!item) {
      yield JSON.stringify({
        should_store: false,
        entry_summary: "",
        facts: [],
        rejection_reason: "未命中专项用例"
      });
      return;
    }

    yield JSON.stringify({
      should_store: true,
      entry_summary: `${item.id} 用户信息摘要`,
      facts: [
        {
          subject: item.subject,
          predicate: item.predicate,
          object: item.object,
          valueType: "text",
          confidence: 0.95
        }
      ],
      rejection_reason: ""
    });
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
      rewritten_query: "用户身份信息",
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

describe("MemoryExtractor v2 identity normalization", () => {
  it("covers 20 first-person identity cases with >=95% normalization accuracy", async () => {
    const cases = buildIdentityCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);

    const llm = new IdentityExtractionFakeLLM(new Map(cases.map((item) => [item.message, item])));
    const { memoryService } = createMemoryServiceMock();
    const { entryStore, upsertFacts } = createEntryStoreMock();
    const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore });

    let passed = 0;
    for (const item of cases) {
      const result = await extractor.enqueue({
        message: item.message,
        sourceType: "chat_user"
      });
      expect(result.created).toBe(1);

      const call = upsertFacts.mock.calls[upsertFacts.mock.calls.length - 1] as
        | [string, MemoryEntryUpsertFactInput[]]
        | undefined;
      const fact = call?.[1]?.[0];
      const subjectOk = fact?.subjectText === "用户";
      const predicateOk = fact?.predicate === item.expectedPredicate;
      if (subjectOk && predicateOk) {
        passed += 1;
      }
    }

    const accuracy = passed / cases.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
  });
});

function buildIdentityCases(): IdentityCase[] {
  return [
    { id: "D4-01", message: "我是张三。", subject: "我", predicate: "是", object: "张三", expectedPredicate: "身份" },
    { id: "D4-02", message: "我叫李四。", subject: "我", predicate: "叫", object: "李四", expectedPredicate: "姓名" },
    { id: "D4-03", message: "我的名字是王五。", subject: "我", predicate: "名字", object: "王五", expectedPredicate: "姓名" },
    { id: "D4-04", message: "我的职业是后端工程师。", subject: "我", predicate: "职业", object: "后端工程师", expectedPredicate: "职业" },
    { id: "D4-05", message: "我的工作是产品经理。", subject: "我", predicate: "工作", object: "产品经理", expectedPredicate: "职业" },
    { id: "D4-06", message: "我的职位是架构师。", subject: "我", predicate: "职位", object: "架构师", expectedPredicate: "职业" },
    { id: "D4-07", message: "我的身份是自由职业者。", subject: "我", predicate: "身份", object: "自由职业者", expectedPredicate: "身份" },
    { id: "D4-08", message: "我来自上海。", subject: "我", predicate: "来自", object: "上海", expectedPredicate: "来源地" },
    { id: "D4-09", message: "我的家乡是杭州。", subject: "我", predicate: "家乡", object: "杭州", expectedPredicate: "来源地" },
    { id: "D4-10", message: "我的籍贯是苏州。", subject: "我", predicate: "籍贯", object: "苏州", expectedPredicate: "来源地" },
    { id: "D4-11", message: "你叫赵六。", subject: "你", predicate: "叫", object: "赵六", expectedPredicate: "姓名" },
    { id: "D4-12", message: "你的职业是设计师。", subject: "你", predicate: "职业", object: "设计师", expectedPredicate: "职业" },
    { id: "D4-13", message: "您来自北京。", subject: "您", predicate: "来自", object: "北京", expectedPredicate: "来源地" },
    { id: "D4-14", message: "本人叫陈七。", subject: "本人", predicate: "叫", object: "陈七", expectedPredicate: "姓名" },
    { id: "D4-15", message: "咱是测试工程师。", subject: "咱", predicate: "是", object: "测试工程师", expectedPredicate: "职业" },
    { id: "D4-16", message: "我自己的身份是创业者。", subject: "我自己", predicate: "身份", object: "创业者", expectedPredicate: "身份" },
    { id: "D4-17", message: "我偏好咖啡。", subject: "我", predicate: "偏好", object: "咖啡", expectedPredicate: "偏好" },
    { id: "D4-18", message: "我喜欢跑步。", subject: "我", predicate: "喜欢", object: "跑步", expectedPredicate: "偏好" },
    { id: "D4-19", message: "我不喜欢香菜。", subject: "我", predicate: "不喜欢", object: "香菜", expectedPredicate: "偏好" },
    { id: "D4-20", message: "俺来自成都。", subject: "俺", predicate: "来自", object: "成都", expectedPredicate: "来源地" }
  ];
}

function createMemoryServiceMock() {
  const memoryService: MemoryServiceLike = {
    mergeFacts: () => ({ created: 0, updated: 0, conflicted: 0 }),
    reviewFact: () => null,
    retrieveRelevant: () => [],
    buildMemoryContextText: () => "",
    createEntry: async (content: string): Promise<MemoryEntry> => buildEntry(content),
    updateEntry: async () => null,
    getEntryWithFacts: async () => null
  };
  return { memoryService };
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
