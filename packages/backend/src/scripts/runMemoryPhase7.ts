import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import type {
  AbstractGraphStore,
  ChunkSearchResult,
  Document,
  DocumentChunk,
  GraphEdge,
  GraphNode,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";
import type { Pool } from "pg";
import { appConfig } from "../config.js";
import { DocumentPipeline } from "../pipeline/DocumentPipeline.js";
import { createMemoryRouter } from "../routes/memory.js";
import { closePgPoolSingleton, getPgPoolSingleton } from "../runtime/PgPool.js";
import { applyPhase0MemorySchema } from "../runtime/pgMemorySchema.js";
import { ChatService } from "../services/ChatService.js";
import { InMemoryChatStore } from "../services/InMemoryChatStore.js";
import { MemoryExtractor } from "../services/MemoryExtractor.js";
import { MemoryService } from "../services/MemoryService.js";
import { PgMemoryStore } from "../services/PgMemoryStore.js";
import type {
  ExtractionResult,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext
} from "../services/llmTypes.js";
import { GraphSyncWorker, type Neo4jSyncTargetLike } from "../workers/GraphSyncWorker.js";

interface LatencyStats {
  sampleSize: number;
  queryCount: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface GraphSyncPerfStats {
  factCount: number;
  durationMs: number;
  throughputFactsPerSec: number;
}

interface Phase7PerfStats {
  vectorSearch: LatencyStats;
  graphSync: GraphSyncPerfStats;
  pagination: LatencyStats;
}

interface UnitFactRow {
  id: string;
  entry_id: string;
  subject_node_id: string | null;
  subject_text: string;
  predicate: string;
  object_node_id: string | null;
  object_text: string | null;
  normalized_fact_key: string;
  confidence: number;
  created_at: string;
  deleted_at: string | null;
  fact_state: "active" | "deleted";
  neo4j_synced: boolean;
  neo4j_synced_at: string | null;
  neo4j_retry_count: number;
  neo4j_last_error: string | null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function buildEmbedding(seed: number): number[] {
  const dimensions = appConfig.EMBEDDING_DIMENSIONS;
  const values = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const value = Math.sin(seed * 0.17 + index * 0.013) + Math.cos(seed * 0.09 + index * 0.007);
    values[index] = Number((value / 2).toFixed(6));
  }
  return values;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[index] ?? 0;
}

function summarizeLatency(sampleSize: number, durationsMs: number[]): LatencyStats {
  const queryCount = durationsMs.length;
  const total = durationsMs.reduce((sum, value) => sum + value, 0);
  return {
    sampleSize,
    queryCount,
    averageMs: Number((queryCount === 0 ? 0 : total / queryCount).toFixed(3)),
    p50Ms: Number(percentile(durationsMs, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durationsMs, 0.95).toFixed(3)),
    maxMs: Number((durationsMs.length === 0 ? 0 : Math.max(...durationsMs)).toFixed(3))
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

interface FaultInjectingPoolOptions {
  failEvidenceInsertTimes?: number;
  failAccessLogInsertTimes?: number;
}

function normalizeSqlForInspection(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function createFaultInjectingPool(pool: Pool, options: FaultInjectingPoolOptions): Pool {
  let remainingEvidenceFailures = Math.max(0, Math.floor(options.failEvidenceInsertTimes ?? 0));
  let remainingAccessLogFailures = Math.max(0, Math.floor(options.failAccessLogInsertTimes ?? 0));

  const wrapped = {
    query: async (...args: unknown[]): Promise<unknown> => {
      const firstArg = args[0] as string | { text?: string } | undefined;
      const sql = typeof firstArg === "string"
        ? firstArg
        : (typeof firstArg?.text === "string" ? firstArg.text : "");
      const normalizedSql = normalizeSqlForInspection(sql);

      if (
        remainingEvidenceFailures > 0
        && normalizedSql.includes("insert into memory_evidence")
      ) {
        remainingEvidenceFailures -= 1;
        throw new Error("Phase7 simulated memory_evidence insert failure");
      }

      if (
        remainingAccessLogFailures > 0
        && normalizedSql.includes("insert into memory_access_logs")
      ) {
        remainingAccessLogFailures -= 1;
        throw new Error("Phase7 simulated memory_access_logs insert failure");
      }

      return (pool.query as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
    }
  };

  return wrapped as unknown as Pool;
}

async function getOperationalMetricCount(
  pool: Pool,
  metricName: "document_memory_extraction" | "memory_evidence_write" | "memory_access_log_write",
  outcome: "success" | "failure" | "deduplicated",
  sourceType: "all" | "document" | "chat_user" | "chat_assistant" | "manual" = "all"
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `
      SELECT COALESCE(SUM(metric_count), 0)::int AS count
      FROM memory_operational_metrics
      WHERE metric_date = CURRENT_DATE
        AND metric_name = $1
        AND outcome = $2
        AND source_type = $3
    `,
    [metricName, outcome, sourceType]
  );
  return result.rows[0]?.count ?? 0;
}

function extractFactsFromText(text: string): Array<{
  subject: string;
  predicate: string;
  object: string;
  valueType: "entity" | "text" | "number" | "date";
  confidence: number;
}> {
  const facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    valueType: "entity" | "text" | "number" | "date";
    confidence: number;
  }> = [];

  if (text.includes("张三")) {
    facts.push({
      subject: "张三",
      predicate: "职位",
      object: "CTO",
      valueType: "text",
      confidence: 0.94
    });
  }
  if (text.includes("李四")) {
    facts.push({
      subject: "李四",
      predicate: "职位",
      object: "CEO",
      valueType: "text",
      confidence: 0.93
    });
  }
  if (text.includes("项目A")) {
    facts.push({
      subject: "项目A",
      predicate: "状态",
      object: "进行中",
      valueType: "text",
      confidence: 0.9
    });
  }
  if (facts.length === 0) {
    facts.push({
      subject: "Graphen",
      predicate: "特性",
      object: "记忆编织",
      valueType: "text",
      confidence: 0.82
    });
  }

  return facts;
}

class Phase7LLM implements LLMServiceLike {
  public lastChatContext: RAGContext | null = null;

  async extractEntitiesAndRelations(text: string): Promise<ExtractionResult> {
    const entities: ExtractionResult["entities"] = [];
    const relations: ExtractionResult["relations"] = [];

    if (/张三/.test(text)) {
      entities.push({
        name: "张三",
        type: "Person",
        description: "技术负责人",
        confidence: 0.95
      });
    }
    if (/graphen/i.test(text)) {
      entities.push({
        name: "Graphen",
        type: "Technology",
        description: "GraphRAG 平台",
        confidence: 0.94
      });
    }
    if (entities.some((item) => item.name === "张三") && entities.some((item) => item.name === "Graphen")) {
      relations.push({
        source: "张三",
        target: "Graphen",
        type: "任职于",
        description: "张三在 Graphen 任职",
        confidence: 0.9
      });
    }

    if (entities.length === 0) {
      entities.push({
        name: "Graphen",
        type: "Technology",
        description: "GraphRAG 平台",
        confidence: 0.9
      });
    }

    return {
      entities,
      relations
    };
  }

  async *chatCompletion(messages: Array<{ content: string }>, context: RAGContext): AsyncGenerator<string> {
    const prompt = messages[messages.length - 1]?.content ?? "";
    const isExtraction = context.graphContext.includes("事实提取助手")
      || prompt.includes("请从以下消息中提取事实");

    if (isExtraction) {
      const facts = extractFactsFromText(prompt);
      yield JSON.stringify({ facts });
      return;
    }

    this.lastChatContext = context;
    yield "Phase7 chat response";
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return buildEmbedding(Math.max(1, text.length % 211));
  }

  async analyzeQuestion(question: string): Promise<QuestionAnalysis> {
    const keyEntities: string[] = [];
    if (question.includes("张三")) {
      keyEntities.push("张三");
    }
    if (question.includes("李四")) {
      keyEntities.push("李四");
    }
    if (question.includes("项目A")) {
      keyEntities.push("项目A");
    }

    return {
      intent: "factual",
      key_entities: keyEntities,
      retrieval_strategy: {
        use_graph: true,
        use_vector: true,
        graph_depth: 1,
        vector_top_k: 5,
        need_aggregation: false
      },
      rewritten_query: question,
      memory_intent: "none",
      target_subject: "unknown",
      must_use_memory: false,
      retrieval_weights: {
        entry_manual: 0.2,
        entry_chat: 0.2,
        entry_document: 0.4,
        graph_facts: 0.8,
        doc_chunks: 0.8
      },
      conflict_policy: "latest_manual_wins"
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

class Phase7GraphStore implements AbstractGraphStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async getStats() {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      documentCount: 0,
      nodeTypeDistribution: {},
      edgeTypeDistribution: {}
    };
  }

  async saveNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async getNodesByType(type: string, limit = 100, offset = 0): Promise<GraphNode[]> {
    return [...this.nodes.values()]
      .filter((node) => node.type === type)
      .slice(offset, offset + limit);
  }

  async searchNodes(query: string, limit = 10): Promise<SearchResult[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return [];
    }

    const hits = [...this.nodes.values()]
      .filter((node) => node.name.toLowerCase().includes(normalized))
      .slice(0, limit)
      .map((node) => ({ node, score: 1 }));

    return hits;
  }

  async deleteNode(id: string): Promise<void> {
    this.nodes.delete(id);
    for (const [edgeId, edge] of this.edges) {
      if (edge.sourceNodeId === id || edge.targetNodeId === id) {
        this.edges.delete(edgeId);
      }
    }
  }

  async saveEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      this.edges.set(edge.id, edge);
    }
  }

  async getEdgesByNode(nodeId: string): Promise<GraphEdge[]> {
    return [...this.edges.values()].filter(
      (edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId
    );
  }

  async deleteEdge(id: string): Promise<void> {
    this.edges.delete(id);
  }

  async getNeighbors(nodeId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const edges = await this.getEdgesByNode(nodeId);
    const nodeIds = new Set<string>([nodeId]);
    for (const edge of edges) {
      nodeIds.add(edge.sourceNodeId);
      nodeIds.add(edge.targetNodeId);
    }
    const nodes = [...nodeIds]
      .map((id) => this.nodes.get(id))
      .filter((node): node is GraphNode => !!node);
    return { nodes, edges };
  }

  async getSubgraph(query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const centerIds = query.centerNodeIds ?? [];
    if (centerIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    const centerSet = new Set(centerIds);
    const edges = [...this.edges.values()].filter(
      (edge) => centerSet.has(edge.sourceNodeId) || centerSet.has(edge.targetNodeId)
    );
    const nodeIds = new Set<string>(centerIds);
    for (const edge of edges) {
      nodeIds.add(edge.sourceNodeId);
      nodeIds.add(edge.targetNodeId);
    }

    const maxNodes = query.maxNodes ?? 100;
    const nodes = [...nodeIds]
      .map((id) => this.nodes.get(id))
      .filter((node): node is GraphNode => !!node)
      .slice(0, maxNodes);
    const allowedNodeIds = new Set(nodes.map((node) => node.id));
    const filteredEdges = edges.filter(
      (edge) => allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId)
    );

    return {
      nodes,
      edges: filteredEdges
    };
  }
}

class InMemoryPhase7DocumentStore {
  private readonly documents = new Map<string, Document>();
  private readonly chunks = new Map<string, DocumentChunk>();

  async saveDocument(doc: Document): Promise<void> {
    this.documents.set(doc.id, doc);
  }

  async saveChunks(chunks: DocumentChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
  }

  async getDocumentById(id: string): Promise<Document | null> {
    return this.documents.get(id) ?? null;
  }

  async getDocuments(): Promise<Document[]> {
    return [...this.documents.values()];
  }

  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.documentId === docId)
      .sort((left, right) => left.index - right.index);
  }

  async chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]> {
    const scored = [...this.chunks.values()].map((chunk) => {
      const score = cosineSimilarity(vector, chunk.embedding ?? []);
      return { chunk, score };
    });
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, k);
  }
}

class EmptyChunkContextStore {
  async chunkVectorSearch(): Promise<ChunkSearchResult[]> {
    return [];
  }

  async getDocuments(): Promise<Document[]> {
    return [];
  }
}

class RecordingNeo4jTarget implements Neo4jSyncTargetLike {
  public readonly calls: Array<{
    query: string;
    params: Record<string, unknown>;
  }> = [];

  private readonly failOnceFactIds = new Set<string>();
  private readonly failedFactIds = new Set<string>();

  failOnceForFact(factId: string): void {
    this.failOnceFactIds.add(factId);
  }

  async runCypher(query: string, params: Record<string, unknown> = {}): Promise<void> {
    this.calls.push({ query, params });

    const factId = typeof params.factId === "string" ? params.factId : null;
    if (!factId) {
      return;
    }
    if (!this.failOnceFactIds.has(factId)) {
      return;
    }
    if (this.failedFactIds.has(factId)) {
      return;
    }

    this.failedFactIds.add(factId);
    throw new Error(`simulated neo4j failure for fact ${factId}`);
  }
}

class InMemoryGraphSyncClient {
  constructor(private readonly facts: UnitFactRow[]) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();

    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("from memory_facts") && sql.includes("for update skip locked")) {
      const batchSize = Number(values[0] ?? 100);
      const maxRetries = Number(values[1] ?? 3);
      const rows = this.facts
        .filter((fact) =>
          !fact.neo4j_synced
          && fact.deleted_at === null
          && fact.fact_state === "active"
          && fact.subject_text.trim().length > 0
          && fact.predicate.trim().length > 0
          && (
            fact.object_node_id !== null
            || (fact.object_text !== null && fact.object_text.trim().length > 0)
          )
          && fact.neo4j_retry_count < maxRetries
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .slice(0, batchSize)
        .map((fact) => ({
          id: fact.id,
          entry_id: fact.entry_id,
          subject_node_id: fact.subject_node_id,
          subject_text: fact.subject_text,
          predicate: fact.predicate,
          object_node_id: fact.object_node_id,
          object_text: fact.object_text,
          normalized_fact_key: fact.normalized_fact_key,
          confidence: fact.confidence,
          created_at: fact.created_at
        }));

      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    if (sql.includes("set neo4j_retry_count = neo4j_retry_count + 1")) {
      const factId = String(values[0] ?? "");
      const reason = String(values[1] ?? "unknown");
      const fact = this.facts.find((item) => item.id === factId);
      if (fact) {
        fact.neo4j_retry_count += 1;
        fact.neo4j_last_error = reason;
      }
      return { rows: [], rowCount: fact ? 1 : 0 };
    }

    if (sql.includes("set neo4j_synced = true")) {
      const ids = Array.isArray(values[0]) ? values[0].map(String) : [];
      let affected = 0;
      for (const fact of this.facts) {
        if (ids.includes(fact.id)) {
          fact.neo4j_synced = true;
          fact.neo4j_synced_at = new Date().toISOString();
          fact.neo4j_last_error = null;
          affected += 1;
        }
      }
      return { rows: [], rowCount: affected };
    }

    throw new Error(`Unsupported query in InMemoryGraphSyncClient: ${sql}`);
  }

  release(): void {}
}

class InMemoryGraphSyncPool {
  constructor(private readonly facts: UnitFactRow[]) {}

  async connect(): Promise<InMemoryGraphSyncClient> {
    return new InMemoryGraphSyncClient(this.facts);
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForExtractorIdle(extractor: MemoryExtractor, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (extractor.pendingCount > 0 || extractor.isProcessing) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("memory extractor did not become idle in time");
    }
    await sleep(25);
  }
}

async function countPendingFactsForEntries(pool: Pool, entryIds: string[]): Promise<number> {
  if (entryIds.length === 0) {
    return 0;
  }

  const result = await pool.query<{ count: number }>(
    `
      SELECT COUNT(*)::int AS count
      FROM memory_facts
      WHERE entry_id = ANY($1::uuid[])
        AND deleted_at IS NULL
        AND fact_state = 'active'
        AND neo4j_synced = FALSE
    `,
    [entryIds]
  );
  return result.rows[0]?.count ?? 0;
}

async function prioritizeFactsForEntries(pool: Pool, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }

  await pool.query(
    `
      UPDATE memory_facts
      SET created_at = $2::timestamptz
      WHERE entry_id = ANY($1::uuid[])
        AND deleted_at IS NULL
    `,
    [entryIds, "2000-01-01T00:00:00.000Z"]
  );
}

async function syncUntilEntriesSynced(
  pool: Pool,
  neo4j: RecordingNeo4jTarget,
  entryIds: string[]
): Promise<{ attempts: number; totalSynced: number }> {
  const targetEntryIds = dedupeStrings(entryIds);
  await prioritizeFactsForEntries(pool, targetEntryIds);

  const worker = new GraphSyncWorker(pool, neo4j, {
    intervalMs: 20,
    batchSize: 5_000,
    maxRetries: 3
  });

  let attempts = 0;
  let totalSynced = 0;

  while (attempts < 6) {
    attempts += 1;
    const stats = await worker.syncOnce();
    totalSynced += stats.synced;
    const pending = await countPendingFactsForEntries(pool, targetEntryIds);
    if (pending === 0) {
      return { attempts, totalSynced };
    }
  }

  const pending = await countPendingFactsForEntries(pool, targetEntryIds);
  throw new Error(`graph sync still has pending facts for entries after retries: pending=${pending}`);
}

async function runT711PgMemoryStoreUnit(
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>
): Promise<void> {
  const entry = await store.createEntry(
    `Phase7 unit pgmemory ${runTag}`,
    buildEmbedding(11),
    {
      categories: ["phase7", "unit", runTag],
      sourceType: "manual"
    }
  );
  cleanupEntryIds.add(entry.id);

  const deduped = await store.createEntry(
    ` Phase7 unit pgmemory ${runTag} `,
    buildEmbedding(12),
    {
      categories: ["phase7", "unit", "updated", runTag],
      sourceType: "manual",
      reviewStatus: "modified",
      reviewNote: "phase7 dedupe check"
    }
  );
  assert(deduped.id === entry.id, "T7.1.1 expected createEntry dedupe on normalized content key");

  const firstUpsert = await store.upsertFacts(entry.id, [
    {
      subjectText: "张三",
      predicate: "职位",
      objectText: "CTO",
      valueType: "text",
      confidence: 0.91
    },
    {
      subjectText: "张三",
      predicate: "负责",
      objectNodeId: "entity:tech-team",
      objectText: "技术团队",
      valueType: "entity",
      confidence: 0.89
    }
  ]);
  assert(firstUpsert.created === 2, `T7.1.1 expected 2 created facts, got ${firstUpsert.created}`);

  const secondUpsert = await store.upsertFacts(entry.id, [
    {
      subjectText: "张三",
      predicate: "职位",
      objectText: "CTO",
      valueType: "text",
      confidence: 0.96
    }
  ]);
  assert(secondUpsert.updated === 1, `T7.1.1 expected 1 updated fact, got ${secondUpsert.updated}`);

  const facts = await store.getEntryFacts(entry.id);
  assert(facts.length === 2, `T7.1.1 expected 2 facts, got ${facts.length}`);

  const search = await store.searchEntries({
    query: runTag,
    filters: {
      categories: [runTag]
    },
    page: 1,
    pageSize: 10
  });
  assert(search.total >= 1, "T7.1.1 expected searchEntries to find inserted entry");

  const vectorHits = await store.searchEntriesByVector(buildEmbedding(12), 5);
  assert(vectorHits.some((item) => item.id === entry.id), "T7.1.1 expected vector search to hit inserted entry");

  const paused = await store.updateEntryState([entry.id], "paused", "phase7-unit");
  const resumed = await store.updateEntryState([entry.id], "active", "phase7-unit");
  assert(paused === 1 && resumed === 1, "T7.1.1 expected updateEntryState pause/resume to affect 1 row");
}

async function runT712GraphSyncWorkerUnit(): Promise<void> {
  const facts: UnitFactRow[] = [
    {
      id: "fact-a",
      entry_id: "entry-a",
      subject_node_id: null,
      subject_text: "张三",
      predicate: "职位",
      object_node_id: null,
      object_text: "CTO",
      normalized_fact_key: "zhangsan|职位|cto",
      confidence: 0.92,
      created_at: "2025-01-01T00:00:00.000Z",
      deleted_at: null,
      fact_state: "active",
      neo4j_synced: false,
      neo4j_synced_at: null,
      neo4j_retry_count: 0,
      neo4j_last_error: null
    },
    {
      id: "fact-b",
      entry_id: "entry-a",
      subject_node_id: null,
      subject_text: "李四",
      predicate: "职位",
      object_node_id: null,
      object_text: "CEO",
      normalized_fact_key: "lisi|职位|ceo",
      confidence: 0.9,
      created_at: "2025-01-01T00:01:00.000Z",
      deleted_at: null,
      fact_state: "active",
      neo4j_synced: false,
      neo4j_synced_at: null,
      neo4j_retry_count: 0,
      neo4j_last_error: null
    }
  ];

  const neo4j = new RecordingNeo4jTarget();
  neo4j.failOnceForFact("fact-b");

  const fakePool = new InMemoryGraphSyncPool(facts) as unknown as Pool;
  const worker = new GraphSyncWorker(fakePool, neo4j, {
    intervalMs: 10,
    batchSize: 10,
    maxRetries: 3
  });

  const first = await worker.syncOnce();
  assert(first.fetched === 2, `T7.1.2 expected fetched=2 in first sync, got ${first.fetched}`);
  assert(first.synced === 1, `T7.1.2 expected synced=1 in first sync, got ${first.synced}`);
  assert(first.failed === 1, `T7.1.2 expected failed=1 in first sync, got ${first.failed}`);

  const retriedFact = facts.find((fact) => fact.id === "fact-b");
  assert(retriedFact && retriedFact.neo4j_retry_count === 1, "T7.1.2 expected retry count to increment");
  assert(retriedFact.neo4j_last_error, "T7.1.2 expected retry error to be recorded");

  const second = await worker.syncOnce();
  assert(second.fetched === 1, `T7.1.2 expected fetched=1 in second sync, got ${second.fetched}`);
  assert(second.synced === 1, `T7.1.2 expected synced=1 in second sync, got ${second.synced}`);
  assert(second.failed === 0, `T7.1.2 expected failed=0 in second sync, got ${second.failed}`);

  assert(facts.every((fact) => fact.neo4j_synced), "T7.1.2 expected all facts to be synced");
  assert(
    neo4j.calls.some((call) => call.query.includes("MERGE (s:Entity")),
    "T7.1.2 expected sync cypher to include node MERGE"
  );
}

async function runT713MemoryApiUnit(
  pool: Pool,
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>
): Promise<void> {
  const evidenceSuccessBefore = await getOperationalMetricCount(pool, "memory_evidence_write", "success", "manual");
  const evidenceDeduplicatedBefore = await getOperationalMetricCount(pool, "memory_evidence_write", "deduplicated", "manual");
  const evidenceFailureBefore = await getOperationalMetricCount(pool, "memory_evidence_write", "failure", "manual");
  const accessLogSuccessBefore = await getOperationalMetricCount(pool, "memory_access_log_write", "success", "all");
  const accessLogFailureBefore = await getOperationalMetricCount(pool, "memory_access_log_write", "failure", "all");

  const service = new MemoryService(store);
  const llm = new Phase7LLM();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/memory",
    createMemoryRouter({
      entryStore: store,
      service,
      llmService: llm,
      pgPool: pool
    })
  );

  const create = await request(app).post("/api/memory/entries").send({
    content: `Phase7 api unit ${runTag} 张三是CTO`,
    reextract: false,
    facts: [
      {
        subjectText: "张三",
        predicate: "职位",
        objectText: "CTO",
        valueType: "text",
        confidence: 0.9
      }
    ]
  });
  assert(create.status === 201, `T7.1.3 create entry expected 201, got ${create.status}`);

  const entryId = create.body?.entry?.id as string | undefined;
  assert(entryId, "T7.1.3 create entry missing entry id");
  cleanupEntryIds.add(entryId);

  const invalidFactCreate = await request(app).post("/api/memory/facts").send({
    predicate: "职位",
    objectText: "CTO"
  });
  assert(
    invalidFactCreate.status === 400,
    `T7.1.3 expected invalid fact create to return 400, got ${invalidFactCreate.status}`
  );

  const updateEntry = await request(app)
    .put(`/api/memory/entries/${entryId}`)
    .send({
      content: `Phase7 api unit updated ${runTag} 张三依然是CTO`,
      reextract: true,
      replaceFacts: true
    });
  assert(updateEntry.status === 200, `T7.1.3 update entry expected 200, got ${updateEntry.status}`);
  assert(
    Number(updateEntry.body?.extraction?.generated ?? 0) >= 1,
    "T7.1.3 expected update entry to trigger extraction output"
  );

  const dedupeContent = `Phase7 api unit dedupe ${runTag} 张三是CTO`;
  const dedupePayload = {
    content: dedupeContent,
    reextract: false,
    replaceFacts: false,
    facts: [
      {
        subjectText: "张三",
        predicate: "职位",
        objectText: "CTO",
        valueType: "text",
        confidence: 0.94
      }
    ]
  };
  const firstDedupeUpdate = await request(app)
    .put(`/api/memory/entries/${entryId}`)
    .send(dedupePayload);
  assert(firstDedupeUpdate.status === 200, `T7.1.3 dedupe update#1 expected 200, got ${firstDedupeUpdate.status}`);

  const secondDedupeUpdate = await request(app)
    .put(`/api/memory/entries/${entryId}`)
    .send(dedupePayload);
  assert(secondDedupeUpdate.status === 200, `T7.1.3 dedupe update#2 expected 200, got ${secondDedupeUpdate.status}`);

  const filter = await request(app).post("/api/memory/entries/filter").send({
    query: runTag,
    page: 1,
    pageSize: 10
  });
  assert(filter.status === 200, `T7.1.3 entries/filter expected 200, got ${filter.status}`);
  assert(Number(filter.body?.total ?? 0) >= 1, "T7.1.3 entries/filter expected total >= 1");

  const entryFacts = await request(app).get(`/api/memory/entries/${entryId}/facts`);
  assert(entryFacts.status === 200, `T7.1.3 get entry facts expected 200, got ${entryFacts.status}`);
  const factId = (entryFacts.body?.[0]?.id as string | undefined) ?? "";
  assert(factId.length > 0, "T7.1.3 expected at least one fact id");

  const patchFact = await request(app).patch(`/api/memory/facts/${factId}`).send({
    objectText: "首席技术官"
  });
  assert(patchFact.status === 200, `T7.1.3 patch fact expected 200, got ${patchFact.status}`);
  assert(patchFact.body?.reviewStatus === "modified", "T7.1.3 patch fact should mark reviewStatus=modified");

  const compatFacts = await request(app).get("/api/memory/facts").query({ page: 1, pageSize: 5 });
  assert(compatFacts.status === 200, `T7.1.3 facts compatibility expected 200, got ${compatFacts.status}`);
  assert(compatFacts.header["deprecation"] === "true", "T7.1.3 compatibility route should set deprecation header");

  const accessLogOk = await request(app)
    .post(`/api/memory/entries/${entryId}/access-log`)
    .send({});
  assert(accessLogOk.status === 201, `T7.1.3 access-log success expected 201, got ${accessLogOk.status}`);

  const faultPool = createFaultInjectingPool(pool, {
    failEvidenceInsertTimes: 1,
    failAccessLogInsertTimes: 1
  });
  const faultApp = express();
  faultApp.use(express.json());
  faultApp.use(
    "/api/memory",
    createMemoryRouter({
      entryStore: store,
      service,
      llmService: llm,
      pgPool: faultPool
    })
  );

  const faultEvidenceCreate = await request(faultApp).post("/api/memory/entries").send({
    content: `Phase7 api unit evidence-failure ${runTag}`,
    metadata: {
      sourceType: "manual"
    },
    reextract: false,
    facts: [
      {
        subjectText: "李四",
        predicate: "职位",
        objectText: "CEO",
        valueType: "text",
        confidence: 0.92
      }
    ]
  });
  assert(
    faultEvidenceCreate.status === 201,
    `T7.1.3 fault evidence create expected 201, got ${faultEvidenceCreate.status}`
  );
  const faultEntryId = faultEvidenceCreate.body?.entry?.id as string | undefined;
  assert(faultEntryId, "T7.1.3 fault evidence create missing entry id");
  cleanupEntryIds.add(faultEntryId);

  const faultAccessLog = await request(faultApp)
    .post(`/api/memory/entries/${entryId}/access-log`)
    .send({
      accessType: "manual_view"
    });
  assert(faultAccessLog.status === 500, `T7.1.3 fault access-log expected 500, got ${faultAccessLog.status}`);

  const evidenceSuccessAfter = await getOperationalMetricCount(pool, "memory_evidence_write", "success", "manual");
  const evidenceDeduplicatedAfter = await getOperationalMetricCount(pool, "memory_evidence_write", "deduplicated", "manual");
  const evidenceFailureAfter = await getOperationalMetricCount(pool, "memory_evidence_write", "failure", "manual");
  const accessLogSuccessAfter = await getOperationalMetricCount(pool, "memory_access_log_write", "success", "all");
  const accessLogFailureAfter = await getOperationalMetricCount(pool, "memory_access_log_write", "failure", "all");

  assert(
    evidenceSuccessAfter > evidenceSuccessBefore,
    `T7.1.3 expected manual evidence success metric to increase (before=${evidenceSuccessBefore}, after=${evidenceSuccessAfter})`
  );
  assert(
    evidenceDeduplicatedAfter > evidenceDeduplicatedBefore,
    `T7.1.3 expected manual evidence deduplicated metric to increase (before=${evidenceDeduplicatedBefore}, after=${evidenceDeduplicatedAfter})`
  );
  assert(
    evidenceFailureAfter > evidenceFailureBefore,
    `T7.1.3 expected manual evidence failure metric to increase (before=${evidenceFailureBefore}, after=${evidenceFailureAfter})`
  );
  assert(
    accessLogSuccessAfter > accessLogSuccessBefore,
    `T7.1.3 expected access-log success metric to increase (before=${accessLogSuccessBefore}, after=${accessLogSuccessAfter})`
  );
  assert(
    accessLogFailureAfter > accessLogFailureBefore,
    `T7.1.3 expected access-log failure metric to increase (before=${accessLogFailureBefore}, after=${accessLogFailureAfter})`
  );
}

async function runT721DocumentToMemoryToGraph(
  pool: Pool,
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>,
  cleanupDirs: Set<string>
): Promise<void> {
  const llm = new Phase7LLM();
  const documentMetricSuccessBefore = await getOperationalMetricCount(
    pool,
    "document_memory_extraction",
    "success",
    "document"
  );
  const documentMetricFailureBefore = await getOperationalMetricCount(
    pool,
    "document_memory_extraction",
    "failure",
    "document"
  );

  const graphStore = new Phase7GraphStore();
  const documentStore = new InMemoryPhase7DocumentStore();
  const cacheDir = resolve("tmp", `phase7-doc-cache-${runTag}`);
  cleanupDirs.add(cacheDir);

  const pipeline = new DocumentPipeline(
    graphStore,
    llm,
    undefined,
    {
      cacheDir,
      chunkSize: 120,
      chunkOverlap: 0,
      maxChunksPerDocument: 30,
      maxEstimatedTokens: 50_000
    },
    { documentStore }
  );

  const documentId = `phase7-doc-${runTag}`;
  const document: Document = {
    id: documentId,
    filename: `phase7-${runTag}.txt`,
    fileType: "txt",
    fileSize: 0,
    status: "uploading",
    uploadedAt: new Date(),
    metadata: {}
  };
  const content = `Phase7 文档 ${runTag}：张三是 Graphen 的 CTO。`;

  const processed = await pipeline.process(document, Buffer.from(content, "utf8"));
  assert(processed.chunks.length > 0, "T7.2.1 expected document pipeline to create chunks");
  assert(processed.resolvedGraph.nodes.length > 0, "T7.2.1 expected document pipeline to resolve nodes");

  const savedDoc = await documentStore.getDocumentById(documentId);
  assert(savedDoc, "T7.2.1 expected document metadata to be persisted");

  const memoryService = new MemoryService(store);
  const extractor = new MemoryExtractor(llm, memoryService, {}, { entryStore: store, pgPool: pool });
  const chunkId = processed.chunks[0]?.id;
  const extractionResult = await extractor.enqueue({
    message: content,
    sourceType: "document",
    documentId,
    ...(chunkId !== undefined ? { chunkId } : {})
  });
  assert(
    extractionResult.created + extractionResult.updated >= 1,
    "T7.2.1 expected memory extractor to produce at least one fact"
  );
  const documentMetricSuccessAfter = await getOperationalMetricCount(
    pool,
    "document_memory_extraction",
    "success",
    "document"
  );
  assert(
    documentMetricSuccessAfter > documentMetricSuccessBefore,
    `T7.2.1 expected document extraction success metric to increase (before=${documentMetricSuccessBefore}, after=${documentMetricSuccessAfter})`
  );

  const failingLlm: LLMServiceLike = {
    extractEntitiesAndRelations: llm.extractEntitiesAndRelations.bind(llm),
    chatCompletion: async function* (): AsyncGenerator<string> {
      throw new Error("Phase7 simulated document extraction failure");
    },
    generateEmbedding: llm.generateEmbedding.bind(llm),
    analyzeQuestion: llm.analyzeQuestion.bind(llm),
    estimateTokens: llm.estimateTokens.bind(llm)
  };
  const failingExtractor = new MemoryExtractor(
    failingLlm,
    memoryService,
    {},
    { entryStore: store, pgPool: pool }
  );

  let failedAsExpected = false;
  try {
    const failChunkId = processed.chunks[0]?.id;
    await failingExtractor.enqueue({
      message: `${content}（failure probe）`,
      sourceType: "document",
      documentId,
      ...(failChunkId !== undefined ? { chunkId: failChunkId } : {})
    });
  } catch {
    failedAsExpected = true;
  }
  assert(failedAsExpected, "T7.2.1 expected simulated document extraction failure to reject");

  const documentMetricFailureAfter = await getOperationalMetricCount(
    pool,
    "document_memory_extraction",
    "failure",
    "document"
  );
  assert(
    documentMetricFailureAfter > documentMetricFailureBefore,
    `T7.2.1 expected document extraction failure metric to increase (before=${documentMetricFailureBefore}, after=${documentMetricFailureAfter})`
  );

  const search = await store.searchEntries({
    query: runTag,
    page: 1,
    pageSize: 20
  });
  const entryIds = search.entries.map((entry) => entry.id);
  assert(entryIds.length > 0, "T7.2.1 expected extracted entries to be searchable");
  for (const entryId of entryIds) {
    cleanupEntryIds.add(entryId);
  }

  const neo4j = new RecordingNeo4jTarget();
  await syncUntilEntriesSynced(pool, neo4j, entryIds);
  assert(neo4j.calls.length > 0, "T7.2.1 expected graph sync to emit cypher calls");
}

async function runT722ChatExtractionStoreRetrieve(
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>
): Promise<void> {
  const llm = new Phase7LLM();
  const graphStore = new Phase7GraphStore();
  const now = new Date();
  await graphStore.saveNodes([
    {
      id: "node-zhangsan",
      name: "张三",
      type: "Person",
      description: "技术负责人",
      properties: {},
      sourceDocumentIds: [],
      sourceChunkIds: [],
      confidence: 0.95,
      createdAt: now,
      updatedAt: now
    }
  ]);

  const memoryService = new MemoryService(store);
  const memoryExtractor = new MemoryExtractor(llm, memoryService, {}, { entryStore: store });
  const chatStore = new InMemoryChatStore();
  const chatService = new ChatService(
    graphStore,
    chatStore,
    llm,
    {},
    {
      memoryExtractor,
      entryStore: store,
      chunkContextStore: new EmptyChunkContextStore()
    }
  );

  const session = chatStore.createSession({ title: `phase7-chat-${runTag}` });
  for await (const _event of chatService.streamMessage({
    sessionId: session.id,
    content: `Phase7 对话 ${runTag}：张三是CTO`
  })) {
    // consume stream
  }
  await waitForExtractorIdle(memoryExtractor);

  const search = await store.searchEntries({
    query: runTag,
    page: 1,
    pageSize: 20
  });
  assert(search.total >= 1, "T7.2.2 expected chat extraction result to be stored");
  for (const entry of search.entries) {
    cleanupEntryIds.add(entry.id);
  }

  llm.lastChatContext = null;
  for await (const _event of chatService.streamMessage({
    sessionId: session.id,
    content: "张三的职位是什么？"
  })) {
    // consume stream
  }

  const contextText = (llm.lastChatContext as RAGContext | null)?.graphContext ?? "";
  assert(contextText.includes("记忆条目（pgvector 召回）"), "T7.2.2 expected pgvector memory context injection");
  assert(contextText.includes(runTag), "T7.2.2 expected retrieved context to include stored chat memory");
}

async function runT723ManualCreateLlmExtractGraphSync(
  pool: Pool,
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>
): Promise<void> {
  const service = new MemoryService(store);
  const llm = new Phase7LLM();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/memory",
    createMemoryRouter({
      entryStore: store,
      service,
      llmService: llm,
      pgPool: pool
    })
  );

  const created = await request(app).post("/api/memory/entries").send({
    content: `Phase7 手动记忆 ${runTag}：李四是CEO`,
    reextract: true
  });
  assert(created.status === 201, `T7.2.3 create manual entry expected 201, got ${created.status}`);
  assert(
    Number(created.body?.extraction?.generated ?? 0) >= 1,
    "T7.2.3 expected llm extraction to generate facts for manual entry"
  );

  const entryId = created.body?.entry?.id as string | undefined;
  assert(entryId, "T7.2.3 expected created entry id");
  cleanupEntryIds.add(entryId);

  const neo4j = new RecordingNeo4jTarget();
  await syncUntilEntriesSynced(pool, neo4j, [entryId]);
  assert(neo4j.calls.length > 0, "T7.2.3 expected graph sync calls after manual extraction");
}

async function runT731VectorPerformance(
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>
): Promise<LatencyStats> {
  const sampleSize = 180;
  const queryCount = 30;
  const durations: number[] = [];

  for (let index = 0; index < sampleSize; index += 1) {
    const entry = await store.createEntry(
      `Phase7 perf vector ${runTag} item ${index}`,
      buildEmbedding(300 + index),
      {
        categories: ["phase7_perf", runTag],
        sourceType: "manual"
      }
    );
    cleanupEntryIds.add(entry.id);
  }

  for (let index = 0; index < queryCount; index += 1) {
    const started = nowMs();
    const hits = await store.searchEntriesByVector(buildEmbedding(900 + index), 10);
    durations.push(nowMs() - started);
    assert(hits.length > 0, "T7.3.1 expected vector query to return at least one hit");
  }

  return summarizeLatency(sampleSize, durations);
}

async function runT732GraphSyncPerformance(
  pool: Pool,
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>
): Promise<GraphSyncPerfStats> {
  const factCount = 220;
  const entry = await store.createEntry(
    `Phase7 perf graph sync ${runTag}`,
    buildEmbedding(700),
    {
      categories: ["phase7_perf", runTag],
      sourceType: "manual"
    }
  );
  cleanupEntryIds.add(entry.id);

  const facts = new Array(factCount).fill(null).map((_, index) => ({
    subjectText: "性能测试实体",
    predicate: `属性-${index}`,
    objectText: `值-${index}`,
    valueType: "text" as const,
    confidence: 0.8
  }));

  const upsert = await store.upsertFacts(entry.id, facts);
  assert(upsert.facts.length === factCount, `T7.3.2 expected ${factCount} facts, got ${upsert.facts.length}`);

  const neo4j = new RecordingNeo4jTarget();
  await prioritizeFactsForEntries(pool, [entry.id]);
  const worker = new GraphSyncWorker(pool, neo4j, {
    intervalMs: 20,
    batchSize: 10_000,
    maxRetries: 3
  });

  const started = nowMs();
  let totalSynced = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const stats = await worker.syncOnce();
    totalSynced += stats.synced;
    const pending = await countPendingFactsForEntries(pool, [entry.id]);
    if (pending === 0) {
      break;
    }
  }
  const durationMs = nowMs() - started;
  const pending = await countPendingFactsForEntries(pool, [entry.id]);
  assert(pending === 0, `T7.3.2 expected pending facts to be 0, got ${pending}`);

  const throughputFactsPerSec = durationMs <= 0 ? 0 : Number((totalSynced / (durationMs / 1_000)).toFixed(2));
  return {
    factCount,
    durationMs: Number(durationMs.toFixed(3)),
    throughputFactsPerSec
  };
}

async function runT733PaginationPerformance(
  store: PgMemoryStore,
  runTag: string
): Promise<LatencyStats> {
  const queryCount = 30;
  const pageSize = 20;
  const durations: number[] = [];

  for (let index = 0; index < queryCount; index += 1) {
    const page = (index % 9) + 1;
    const started = nowMs();
    const result = await store.searchEntries({
      page,
      pageSize,
      sortBy: "updatedAt",
      sortOrder: "desc",
      filters: {
        categories: [runTag]
      }
    });
    durations.push(nowMs() - started);
    assert(result.total >= pageSize, "T7.3.3 expected enough data for pagination benchmark");
  }

  return summarizeLatency(0, durations);
}

async function runPhase7(
  pool: Pool,
  store: PgMemoryStore,
  runTag: string,
  cleanupEntryIds: Set<string>,
  cleanupDirs: Set<string>
): Promise<Phase7PerfStats> {
  await runT711PgMemoryStoreUnit(store, runTag, cleanupEntryIds);
  await runT712GraphSyncWorkerUnit();
  await runT713MemoryApiUnit(pool, store, runTag, cleanupEntryIds);

  await runT721DocumentToMemoryToGraph(pool, store, runTag, cleanupEntryIds, cleanupDirs);
  await runT722ChatExtractionStoreRetrieve(store, runTag, cleanupEntryIds);
  await runT723ManualCreateLlmExtractGraphSync(pool, store, runTag, cleanupEntryIds);

  const vectorSearch = await runT731VectorPerformance(store, runTag, cleanupEntryIds);
  const graphSync = await runT732GraphSyncPerformance(pool, store, runTag, cleanupEntryIds);
  const pagination = await runT733PaginationPerformance(store, runTag);

  return {
    vectorSearch,
    graphSync,
    pagination
  };
}

async function main(): Promise<void> {
  const runTag = randomUUID().slice(0, 8);
  const pool = getPgPoolSingleton();
  const store = new PgMemoryStore({ pool });
  const cleanupEntryIds = new Set<string>();
  const cleanupDirs = new Set<string>();

  try {
    await applyPhase0MemorySchema(pool);
    const perfStats = await runPhase7(pool, store, runTag, cleanupEntryIds, cleanupDirs);

    console.log("Phase 7 completed successfully.");
    console.log(`Run tag: ${runTag}`);
    console.log("T7.1.1 PgMemoryStore unit test: ok");
    console.log("T7.1.2 GraphSyncWorker unit test: ok");
    console.log("T7.1.3 memory API route unit test: ok");
    console.log("T7.2.1 document upload -> memory extraction -> graph sync: ok");
    console.log("T7.2.2 chat extraction -> storage -> retrieval: ok");
    console.log("T7.2.3 manual memory -> llm extraction -> graph sync: ok");
    console.log(
      `T7.3.1 pgvector semantic search performance: sampleSize=${perfStats.vectorSearch.sampleSize}, queryCount=${perfStats.vectorSearch.queryCount}, avg=${perfStats.vectorSearch.averageMs}ms, p50=${perfStats.vectorSearch.p50Ms}ms, p95=${perfStats.vectorSearch.p95Ms}ms, max=${perfStats.vectorSearch.maxMs}ms`
    );
    console.log(
      `T7.3.2 GraphSyncWorker performance: facts=${perfStats.graphSync.factCount}, duration=${perfStats.graphSync.durationMs}ms, throughput=${perfStats.graphSync.throughputFactsPerSec} facts/s`
    );
    console.log(
      `T7.3.3 pagination performance: queryCount=${perfStats.pagination.queryCount}, avg=${perfStats.pagination.averageMs}ms, p50=${perfStats.pagination.p50Ms}ms, p95=${perfStats.pagination.p95Ms}ms, max=${perfStats.pagination.maxMs}ms`
    );
  } finally {
    if (cleanupEntryIds.size > 0) {
      await store.deleteEntries([...cleanupEntryIds]);
    }
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 7 failed: ${message}`);
  process.exitCode = 1;
});
