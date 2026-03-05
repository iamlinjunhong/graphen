import { randomUUID } from "node:crypto";
import { appConfig } from "../config.js";
import { closePgPoolSingleton } from "../runtime/PgPool.js";
import { MemoryService } from "../services/MemoryService.js";
import { PgChatStore } from "../services/PgChatStore.js";
import { PgMemoryStore } from "../services/PgMemoryStore.js";

interface BenchmarkStats {
  sampleSize: number;
  queryCount: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function buildEmbedding(seed: number): number[] {
  const size = appConfig.EMBEDDING_DIMENSIONS;
  const result = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    // Stable pseudo-random embedding in [-1, 1]
    const raw = Math.sin(seed * 0.371 + i * 0.019) + Math.cos(seed * 0.173 + i * 0.007);
    result[i] = Number((raw / 2).toFixed(6));
  }
  return result;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

async function runVectorBenchmark(store: PgMemoryStore, runTag: string): Promise<BenchmarkStats> {
  const sampleSize = 80;
  const queryCount = 20;
  const ids: string[] = [];
  const durations: number[] = [];

  try {
    for (let i = 0; i < sampleSize; i++) {
      const entry = await store.createEntry(
        `Phase1 benchmark ${runTag} sample ${i}`,
        buildEmbedding(i + 101),
        {
          categories: ["phase1_benchmark"],
          sourceType: "manual"
        }
      );
      ids.push(entry.id);
    }

    for (let i = 0; i < queryCount; i++) {
      const queryVector = buildEmbedding(i + 205);
      const start = process.hrtime.bigint();
      await store.searchEntriesByVector(queryVector, 10);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      durations.push(elapsedMs);
    }
  } finally {
    if (ids.length > 0) {
      await store.deleteEntries(ids);
    }
  }

  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    sampleSize,
    queryCount,
    averageMs: Number((total / durations.length).toFixed(3)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3))
  };
}

async function main(): Promise<void> {
  const runTag = randomUUID().slice(0, 8);
  const pgMemoryStore = new PgMemoryStore();
  const pgChatStore = new PgChatStore();
  const memoryService = new MemoryService(pgMemoryStore);

  const cleanupEntryIds: string[] = [];

  try {
    await pgMemoryStore.tuneEntryVectorIndex();
    const indexDef = await pgMemoryStore.getEntryVectorIndexDefinition();

    // T1.1: Entry/Fact layered methods
    const entry = await pgMemoryStore.createEntry(
      `Phase1 primary entry ${runTag}`,
      buildEmbedding(1),
      {
        categories: ["phase1", "manual"],
        sourceType: "manual"
      }
    );
    cleanupEntryIds.push(entry.id);

    const updatedEntry = await pgMemoryStore.updateEntry(
      entry.id,
      `Phase1 updated entry ${runTag}`,
      buildEmbedding(2),
      {
        reviewStatus: "modified",
        reviewNote: "Phase1 update verification"
      }
    );

    const fetchedEntry = await pgMemoryStore.getEntry(entry.id);
    if (!updatedEntry || !fetchedEntry) {
      throw new Error("entry update/get verification failed");
    }

    const firstUpsert = await pgMemoryStore.upsertFacts(entry.id, [
      {
        subjectText: "张三",
        predicate: "职位",
        objectText: "CTO",
        valueType: "text",
        confidence: 0.94
      },
      {
        subjectText: "张三",
        predicate: "负责",
        objectNodeId: "entity:tech-dept",
        objectText: "技术部门",
        valueType: "entity",
        confidence: 0.9
      }
    ]);

    const secondUpsert = await pgMemoryStore.upsertFacts(entry.id, [
      {
        subjectText: "张三",
        predicate: "职位",
        objectText: "CTO",
        valueType: "text",
        confidence: 0.97
      }
    ]);

    const searchedEntries = await pgMemoryStore.searchEntries({
      query: "updated entry",
      filters: {
        categories: ["phase1"]
      },
      page: 1,
      pageSize: 10
    });

    const vectorEntries = await pgMemoryStore.searchEntriesByVector(buildEmbedding(2), 5);
    const entryFacts = await pgMemoryStore.getEntryFacts(entry.id);

    const pausedCount = await pgMemoryStore.updateEntryState([entry.id], "paused", "phase1-script");
    const restoredCount = await pgMemoryStore.updateEntryState([entry.id], "active", "phase1-script");

    const toDelete = await pgMemoryStore.createEntry(
      `Phase1 delete entry ${runTag}`,
      buildEmbedding(3),
      { sourceType: "manual", categories: ["phase1"] }
    );
    const deletedCount = await pgMemoryStore.deleteEntries([toDelete.id]);

    if (
      firstUpsert.facts.length === 0 ||
      secondUpsert.facts.length === 0 ||
      searchedEntries.total === 0 ||
      vectorEntries.length === 0 ||
      entryFacts.length === 0 ||
      pausedCount === 0 ||
      restoredCount === 0 ||
      deletedCount === 0
    ) {
      throw new Error("T1.1 verification failed");
    }

    // T1.2: PgChatStore
    const session = await pgChatStore.createSession({ title: `Phase1 chat ${runTag}` });
    await pgChatStore.addMessage({
      sessionId: session.id,
      role: "user",
      content: "你好，这是 phase1 测试消息"
    });
    await pgChatStore.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "已收到 phase1 测试消息",
      sources: [
        {
          documentId: "phase1-doc",
          documentName: "phase1.md",
          chunkId: "chunk-1",
          relevanceScore: 0.88,
          snippet: "phase1 snippet"
        }
      ]
    });

    const sessionWithMessages = await pgChatStore.getSessionWithMessages(session.id);
    const updatedTitleOk = await pgChatStore.updateSessionTitle(session.id, `Phase1 chat updated ${runTag}`);
    const listedSessions = await pgChatStore.listSessions(10);
    const deletedSessionOk = await pgChatStore.deleteSession(session.id);
    if (
      !sessionWithMessages ||
      sessionWithMessages.messages.length < 2 ||
      !updatedTitleOk ||
      listedSessions.length === 0 ||
      !deletedSessionOk
    ) {
      throw new Error("T1.2 verification failed");
    }

    // T1.3: MemoryService entry APIs
    const serviceEntry = await memoryService.createEntry(`Phase1 service entry ${runTag}`, {
      sourceType: "manual",
      categories: ["phase1_service"],
      embedding: buildEmbedding(4)
    });
    cleanupEntryIds.push(serviceEntry.id);

    await memoryService.updateEntry(serviceEntry.id, `Phase1 service entry updated ${runTag}`, {
      reviewStatus: "modified",
      reviewNote: "service update",
      embedding: buildEmbedding(5)
    });

    await pgMemoryStore.upsertFacts(serviceEntry.id, [
      {
        subjectText: "李四",
        predicate: "城市",
        objectText: "上海",
        valueType: "text",
        confidence: 0.82
      }
    ]);

    const entryWithFacts = await memoryService.getEntryWithFacts(serviceEntry.id);
    if (!entryWithFacts || entryWithFacts.facts.length === 0) {
      throw new Error("T1.3 verification failed");
    }

    // T1.4: pgvector tuning + benchmark
    const benchmarkStats = await runVectorBenchmark(pgMemoryStore, runTag);

    console.log("Phase 1 completed successfully.");
    console.log(`Run tag: ${runTag}`);
    console.log(`T1.1 create/upsert/search/state/delete: ok`);
    console.log(`T1.2 PgChatStore CRUD: ok`);
    console.log(`T1.3 MemoryService entry APIs: ok`);
    console.log(
      `T1.4 vector benchmark: sampleSize=${benchmarkStats.sampleSize}, queryCount=${benchmarkStats.queryCount}, avg=${benchmarkStats.averageMs}ms, p50=${benchmarkStats.p50Ms}ms, p95=${benchmarkStats.p95Ms}ms, max=${benchmarkStats.maxMs}ms`
    );
    console.log(`idx_entry_embedding: ${indexDef ?? "missing"}`);
  } finally {
    if (cleanupEntryIds.length > 0) {
      await pgMemoryStore.deleteEntries(cleanupEntryIds);
    }
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 1 failed: ${message}`);
  process.exitCode = 1;
});
