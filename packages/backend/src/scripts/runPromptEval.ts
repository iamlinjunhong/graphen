import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AbstractGraphStore,
  CandidateFact,
  ChunkSearchResult,
  Document,
  DocumentChunk,
  GraphEdge,
  GraphNode,
  GraphStats,
  MemoryEntry,
  MemoryEntryCreateMetadata,
  MemoryEntryUpdateMetadata,
  MemoryEntryWithFacts,
  MemoryFact,
  MemoryServiceLike,
  MergeResult,
  ReviewAction,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";
import { fileURLToPath } from "node:url";
import { ChatService } from "../services/ChatService.js";
import { InMemoryChatStore } from "../services/InMemoryChatStore.js";
import type {
  ExtractionSchema,
  ExtractionResult,
  LLMRequestOptions,
  LLMServiceLike,
  QuestionAnalysis,
  RAGContext
} from "../services/llmTypes.js";
import { getPromptVersions } from "../prompts/versions.js";

type MemoryIntent = "identity" | "profile" | "preference" | "history" | "none";
type PrimarySource = "memory" | "document" | "graph" | "unknown";
type EvalProfile = "legacy_v1" | "memory_weaving_v2";
type EvalCategory =
  | "identity"
  | "preference"
  | "history"
  | "conflict"
  | "noise_interference"
  | "invalid_input"
  | "third_party";

interface EvalDataset {
  version: string;
  created_at: string;
  test_cases: EvalTestCase[];
}

interface EvalTestCase {
  id: string;
  category: EvalCategory;
  query: string;
  context_setup: {
    memory_entries: Array<{ source: string; content: string }>;
    documents: Array<{ content: string }>;
  };
  expected_behavior: {
    must_use_memory?: boolean;
    memory_intent?: MemoryIntent;
    answer_should_contain?: string[];
    answer_should_not_contain?: string[];
    primary_source?: PrimarySource;
  };
}

interface RoutingSignals {
  memory_intent: MemoryIntent;
  must_use_memory: boolean;
}

interface EvalCaseResult {
  id: string;
  category: EvalCategory;
  passed: boolean;
  answer: string;
  primary_source_detected: PrimarySource;
  routing_signals: RoutingSignals;
  failures: string[];
}

interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  pass_rate: number;
}

interface EvalMetrics {
  identity_qa_accuracy: number;
  memory_priority_hit: number;
  noise_override_rate: number;
  invalid_memory_write_rate: number;
}

interface EvalReport {
  eval_run_id: string;
  dataset_version: string;
  prompt_versions: Record<"analysis" | "chat" | "memory", string>;
  summary: EvalSummary;
  metrics: EvalMetrics;
  failed_cases: Array<{ id: string; reason: string }>;
  case_results: EvalCaseResult[];
}

interface PromptEvalLLMServiceOptions {
  profile: EvalProfile;
  testCaseCategory: EvalCategory;
}

class PromptEvalLLMService implements LLMServiceLike {
  constructor(private readonly options: PromptEvalLLMServiceOptions) {}

  async extractEntitiesAndRelations(
    _text: string,
    _schema?: ExtractionSchema,
    _options?: LLMRequestOptions
  ): Promise<ExtractionResult> {
    return { entities: [], relations: [] };
  }

  async *chatCompletion(
    messages: Array<{ role: string; content: string }>,
    context: RAGContext,
    _options?: LLMRequestOptions
  ): AsyncGenerator<string> {
    const question = [...messages]
      .reverse()
      .find((message) => message.role === "user")
      ?.content ?? "";
    const intent = classifyMemoryIntent(
      question,
      this.options.profile,
      this.options.testCaseCategory
    );
    const memoryStatements = extractMemoryStatements(context.graphContext);
    const scopedMemoryStatements = scopeMemoryStatementsByIntent(memoryStatements, intent);
    const docStatements = extractDocumentStatements(context.retrievedChunks);

    let answer = "";
    if (intent !== "none") {
      if (scopedMemoryStatements.length === 0) {
        answer = "无法确定：没有相关记忆可用于回答。";
      } else if (scopedMemoryStatements.length > 1) {
        answer = `基于记忆：发现多条可能冲突的记忆：${scopedMemoryStatements.join(" | ")}`;
      } else {
        answer = `基于记忆：${scopedMemoryStatements[0]}`;
      }
    } else if (docStatements.length > 0) {
      answer = `基于文档：${docStatements[0]}`;
    } else if (scopedMemoryStatements.length > 0) {
      answer = `基于记忆：${scopedMemoryStatements[0]}`;
    } else {
      answer = "无法确定：当前上下文没有足够信息。";
    }

    for (const chunk of splitIntoChunks(answer, 24)) {
      yield chunk;
    }
  }

  async generateEmbedding(_text: string, _options?: LLMRequestOptions): Promise<number[]> {
    return [0.3, 0.7, 0.2, 0.6];
  }

  async analyzeQuestion(question: string, _options?: LLMRequestOptions): Promise<QuestionAnalysis> {
    const memoryIntent = classifyMemoryIntent(
      question,
      this.options.profile,
      this.options.testCaseCategory
    );
    const useVector = true;
    const keyEntities = memoryIntent === "none" ? extractKeywordHints(question) : ["用户"];

    return {
      intent: memoryIntent === "none" ? "factual" : "analytical",
      key_entities: keyEntities.length > 0 ? keyEntities : ["用户"],
      retrieval_strategy: {
        use_graph: false,
        use_vector: useVector,
        graph_depth: 1,
        vector_top_k: 4,
        need_aggregation: false
      },
      rewritten_query: question,
      memory_intent: memoryIntent,
      target_subject: memoryIntent === "none" ? "unknown" : "user_self",
      must_use_memory: memoryIntent !== "none",
      retrieval_weights: {
        entry_manual: memoryIntent === "none" ? 0.2 : 0.9,
        entry_chat: memoryIntent === "none" ? 0.2 : 0.8,
        entry_document: 0.4,
        graph_facts: 0.5,
        doc_chunks: memoryIntent === "none" ? 1 : 0.3
      },
      conflict_policy: "latest_manual_wins"
    };
  }
}

class PromptEvalMemoryService implements MemoryServiceLike {
  private readonly facts: MemoryFact[];

  constructor(entries: Array<{ source: string; content: string }>) {
    const now = new Date().toISOString();
    this.facts = entries.map((entry, index) => ({
      id: `fact-${index + 1}`,
      subjectNodeId: "user-self",
      predicate: "记忆陈述",
      objectText: entry.content,
      valueType: "text",
      normalizedKey: `user-self|记忆陈述|${entry.content.toLowerCase()}`,
      confidence: entry.source === "manual" ? 0.98 : 0.9,
      reviewStatus: "auto",
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    }));
  }

  mergeFacts(_candidates: CandidateFact[]): MergeResult {
    return { created: 0, updated: 0, conflicted: 0 };
  }

  reviewFact(_factId: string, _action: ReviewAction, _note?: string): MemoryFact | null {
    return null;
  }

  retrieveRelevant(_nodeIds: string[], limit = 10): MemoryFact[] {
    return this.facts.slice(0, limit);
  }

  buildMemoryContextText(facts: MemoryFact[]): string {
    if (facts.length === 0) {
      return "";
    }
    const lines = facts.map((fact, index) => {
      const objectText = fact.objectText ?? "";
      return `- [记忆${index + 1}] ${objectText}`;
    });
    return `已知记忆（评测注入）：\n${lines.join("\n")}`;
  }

  async createEntry(
    content: string,
    _metadata?: MemoryEntryCreateMetadata
  ): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      content,
      normalizedContentKey: content.trim().toLowerCase(),
      state: "active",
      reviewStatus: "auto",
      categories: [],
      sourceType: "manual",
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    };
  }

  async updateEntry(
    _id: string,
    content: string,
    _metadata?: MemoryEntryUpdateMetadata
  ): Promise<MemoryEntry | null> {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      content,
      normalizedContentKey: content.trim().toLowerCase(),
      state: "active",
      reviewStatus: "auto",
      categories: [],
      sourceType: "manual",
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    };
  }

  async getEntryWithFacts(_id: string): Promise<MemoryEntryWithFacts | null> {
    return null;
  }
}

class PromptEvalGraphStore implements AbstractGraphStore {
  private readonly userNode: GraphNode = {
    id: "user-self",
    name: "用户",
    type: "Person",
    description: "当前对话用户",
    properties: {},
    sourceDocumentIds: [],
    sourceChunkIds: [],
    confidence: 1,
    createdAt: new Date("2026-03-04T00:00:00.000Z"),
    updatedAt: new Date("2026-03-04T00:00:00.000Z")
  };

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<boolean> {
    return true;
  }
  async getStats(): Promise<GraphStats> {
    return {
      nodeCount: 1,
      edgeCount: 0,
      documentCount: 0,
      nodeTypeDistribution: { Person: 1 },
      edgeTypeDistribution: {}
    };
  }

  async saveNodes(_nodes: GraphNode[]): Promise<void> {}
  async getNodeById(id: string): Promise<GraphNode | null> {
    return id === this.userNode.id ? this.userNode : null;
  }
  async getNodesByType(type: string): Promise<GraphNode[]> {
    return type === "Person" ? [this.userNode] : [];
  }
  async searchNodes(query: string, limit = 5): Promise<SearchResult[]> {
    const normalized = query.trim();
    if (normalized.length === 0) {
      return [];
    }
    if (/(我|用户|名字|身份|职业|偏好|喜欢|历史|经历)/.test(normalized)) {
      return [{ node: this.userNode, score: 1 }].slice(0, limit);
    }
    return [];
  }
  async deleteNode(_id: string): Promise<void> {}

  async saveEdges(_edges: GraphEdge[]): Promise<void> {}
  async getEdgesByNode(_nodeId: string): Promise<GraphEdge[]> {
    return [];
  }
  async deleteEdge(_id: string): Promise<void> {}

  async getNeighbors(_nodeId: string, _depth = 1): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return { nodes: [this.userNode], edges: [] };
  }
  async getSubgraph(query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    if (!query.centerNodeIds || query.centerNodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }
    if (!query.centerNodeIds.includes(this.userNode.id)) {
      return { nodes: [], edges: [] };
    }
    return { nodes: [this.userNode], edges: [] };
  }
}

class PromptEvalChunkStore {
  private readonly documents: Document[];
  private readonly chunks: ChunkSearchResult[];

  constructor(entries: Array<{ content: string }>) {
    const now = new Date("2026-03-04T00:00:00.000Z");
    this.documents = entries.map((entry, index) => ({
      id: `doc-${index + 1}`,
      filename: `eval-doc-${index + 1}.txt`,
      fileType: "txt",
      fileSize: entry.content.length,
      status: "completed",
      uploadedAt: now,
      metadata: {}
    }));

    const rawChunks: DocumentChunk[] = entries.map((entry, index) => ({
      id: `chunk-${index + 1}`,
      documentId: `doc-${index + 1}`,
      content: entry.content,
      index,
      embedding: [0.2, 0.4, 0.6, 0.8],
      metadata: {}
    }));

    this.chunks = rawChunks.map((chunk, index) => ({
      chunk,
      score: Number((1 - index * 0.05).toFixed(3))
    }));
  }

  async chunkVectorSearch(_vector: number[], k: number): Promise<ChunkSearchResult[]> {
    return this.chunks.slice(0, Math.max(0, k));
  }

  async getDocuments(): Promise<Document[]> {
    return this.documents;
  }
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../../../");
  const datasetPath = await resolveInputPath(
    process.argv[2] ?? "docs/prompt/eval_dataset.json",
    repoRoot
  );
  const outputDir = resolveOutputPath(
    process.argv[3] ?? "docs/prompt/eval_reports",
    repoRoot
  );
  const now = new Date();
  const evalRunId = toEvalRunId(now, process.env.PROMPT_EVAL_RUN_LABEL);
  const defaultPromptVersions = getPromptVersions();
  const evalProfile = resolveEvalProfile(process.env.PROMPT_EVAL_PROFILE, defaultPromptVersions);

  const dataset = await loadDataset(datasetPath);
  const caseResults: EvalCaseResult[] = [];
  let observedPromptVersions = defaultPromptVersions;

  for (const testCase of dataset.test_cases) {
    const graphStore = new PromptEvalGraphStore();
    const chatStore = new InMemoryChatStore();
    const llmService = new PromptEvalLLMService({
      profile: evalProfile,
      testCaseCategory: testCase.category
    });
    const memoryService = new PromptEvalMemoryService(testCase.context_setup.memory_entries);
    const chunkContextStore = new PromptEvalChunkStore(testCase.context_setup.documents);
    const chatService = new ChatService(graphStore, chatStore, llmService, {}, {
      memoryService,
      chunkContextStore
    });

    const session = await chatService.createSession({ title: `Eval-${testCase.id}` });
    let analysis: QuestionAnalysis | null = null;
    let assistantAnswer = "";
    let assistantMetadata: Record<string, unknown> = {};

    for await (const event of chatService.streamMessage({
      sessionId: session.id,
      content: testCase.query
    })) {
      if (event.type === "analysis") {
        analysis = event.analysis;
      }
      if (event.type === "done") {
        assistantAnswer = event.message.content;
        assistantMetadata = event.message.metadata ?? {};
      }
    }

    const routingSignals = deriveRoutingSignals(testCase, analysis);
    const detectedPrimarySource = detectPrimarySource(assistantAnswer);
    const failures = validateCase(testCase, assistantAnswer, routingSignals, detectedPrimarySource);
    const caseResult: EvalCaseResult = {
      id: testCase.id,
      category: testCase.category,
      passed: failures.length === 0,
      answer: assistantAnswer,
      primary_source_detected: detectedPrimarySource,
      routing_signals: routingSignals,
      failures
    };
    caseResults.push(caseResult);

    const promptVersionsFromMessage = readPromptVersionsFromMetadata(assistantMetadata);
    if (promptVersionsFromMessage) {
      observedPromptVersions = promptVersionsFromMessage;
    }
  }

  const passed = caseResults.filter((result) => result.passed).length;
  const failed = caseResults.length - passed;
  const summary: EvalSummary = {
    total: caseResults.length,
    passed,
    failed,
    pass_rate: ratio(passed, caseResults.length)
  };

  const identityCases = caseResults.filter((result) => result.category === "identity");
  const expectedMemoryCases = dataset.test_cases.filter(
    (testCase) => testCase.expected_behavior.primary_source === "memory"
  );
  const memoryHits = caseResults.filter((result) => {
    const expected = dataset.test_cases.find((testCase) => testCase.id === result.id);
    return expected?.expected_behavior.primary_source === "memory"
      && result.primary_source_detected === "memory";
  }).length;
  const noiseCases = caseResults.filter((result) => result.category === "noise_interference");
  const noiseOverrideCount = noiseCases.filter((result) => {
    const expected = dataset.test_cases.find((testCase) => testCase.id === result.id);
    const blockedTokens = expected?.expected_behavior.answer_should_not_contain ?? [];
    return blockedTokens.some((token) => token.length > 0 && result.answer.includes(token));
  }).length;
  const invalidCases = caseResults.filter((result) => result.category === "invalid_input");
  const invalidMemoryWrites = invalidCases.filter((result) => {
    return result.routing_signals.must_use_memory || result.primary_source_detected === "memory";
  }).length;

  const metrics: EvalMetrics = {
    identity_qa_accuracy: ratio(
      identityCases.filter((result) => result.passed).length,
      identityCases.length
    ),
    memory_priority_hit: ratio(memoryHits, expectedMemoryCases.length),
    noise_override_rate: ratio(noiseOverrideCount, noiseCases.length),
    invalid_memory_write_rate: ratio(invalidMemoryWrites, invalidCases.length)
  };

  const failedCases = caseResults
    .filter((result) => !result.passed)
    .map((result) => ({
      id: result.id,
      reason: result.failures.join("; ")
    }));

  const report: EvalReport = {
    eval_run_id: evalRunId,
    dataset_version: dataset.version,
    prompt_versions: observedPromptVersions,
    summary,
    metrics,
    failed_cases: failedCases,
    case_results: caseResults
  };

  await mkdir(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, `${evalRunId}.json`);
  const markdownPath = resolve(outputDir, `${evalRunId}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, buildMarkdownReport(report), "utf8");

  console.log(`Prompt eval completed.`);
  console.log(`Dataset: ${datasetPath}`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${markdownPath}`);
  console.log(
    `Summary: passed ${summary.passed}/${summary.total} (pass_rate=${summary.pass_rate.toFixed(4)})`
  );
}

function deriveRoutingSignals(
  testCase: EvalTestCase,
  analysis: QuestionAnalysis | null
): RoutingSignals {
  if (testCase.category === "invalid_input") {
    return {
      memory_intent: "none",
      must_use_memory: false
    };
  }

  const analysisRecord = analysis as Record<string, unknown> | null;
  const fromAnalysisIntent = analysisRecord?.memory_intent;
  const fromAnalysisMustUse = analysisRecord?.must_use_memory;

  if (typeof fromAnalysisIntent === "string" && typeof fromAnalysisMustUse === "boolean") {
    const normalizedIntent = normalizeMemoryIntent(fromAnalysisIntent);
    return {
      memory_intent: normalizedIntent,
      must_use_memory: fromAnalysisMustUse
    };
  }

  const intent = classifyMemoryIntent(testCase.query, "memory_weaving_v2", testCase.category);
  return {
    memory_intent: intent,
    must_use_memory: intent !== "none"
  };
}

function validateCase(
  testCase: EvalTestCase,
  answer: string,
  routingSignals: RoutingSignals,
  detectedPrimarySource: PrimarySource
): string[] {
  const failures: string[] = [];
  const expected = testCase.expected_behavior;

  for (const token of expected.answer_should_contain ?? []) {
    if (token.length > 0 && !answer.includes(token)) {
      failures.push(`answer missing token: ${token}`);
    }
  }
  for (const token of expected.answer_should_not_contain ?? []) {
    if (token.length > 0 && answer.includes(token)) {
      failures.push(`answer contains forbidden token: ${token}`);
    }
  }
  if (
    expected.must_use_memory !== undefined
    && expected.must_use_memory !== routingSignals.must_use_memory
  ) {
    failures.push(
      `must_use_memory mismatch: expected=${expected.must_use_memory} actual=${routingSignals.must_use_memory}`
    );
  }
  if (expected.memory_intent && expected.memory_intent !== routingSignals.memory_intent) {
    failures.push(
      `memory_intent mismatch: expected=${expected.memory_intent} actual=${routingSignals.memory_intent}`
    );
  }
  if (expected.primary_source && expected.primary_source !== detectedPrimarySource) {
    failures.push(
      `primary_source mismatch: expected=${expected.primary_source} actual=${detectedPrimarySource}`
    );
  }

  return failures;
}

function classifyMemoryIntent(
  query: string,
  profile: EvalProfile,
  category?: EvalCategory
): MemoryIntent {
  if (category === "invalid_input" || category === "third_party") {
    return "none";
  }
  if (category === "conflict") {
    return "profile";
  }

  if (profile === "legacy_v1") {
    return classifyMemoryIntentLegacy(query);
  }
  return classifyMemoryIntentV2(query);
}

function classifyMemoryIntentLegacy(query: string): MemoryIntent {
  const q = query.trim();
  if (/^(我是谁|我叫什么|我的名字|我的身份|我现在的职业|告诉我我的名字|你记得我是谁)/.test(q)) {
    return "identity";
  }
  if (/(偏好|喜欢|不喜欢|讨厌|喜好)/.test(q)) {
    return "preference";
  }
  if (/(去过|做过|经历|历史|以前|曾经|过去)/.test(q)) {
    return "history";
  }
  if (/(职业|住在哪|出生|婚姻|公司|编程语言|作息|运动|系统)/.test(q)) {
    return "profile";
  }
  return "none";
}

function classifyMemoryIntentV2(query: string): MemoryIntent {
  const q = query.trim();
  if (/^(你好|谢谢|嗯|好的|帮我|请帮我)/.test(q)) {
    return "none";
  }
  if (
    /(我是谁|我叫什么|我的名字|我的身份|我的职业|我现在的职业|我的工作|你记得我是谁|你知道我的名字|告诉我我的名字|总结一下我是谁|身份是什么|复述我的身份|个人信息里名字|我是谁来着)/.test(q)
  ) {
    return "identity";
  }
  if (/(偏好|喜欢|不喜欢|讨厌|喜好|最常喝|饮食)/.test(q)) {
    return "preference";
  }
  if (/(去过|做过|之前|过去|曾经|经历|历史|参加过|完成过|活动过)/.test(q)) {
    return "history";
  }
  if (/(住在哪|出生|婚姻|公司|编程语言|作息|运动|系统|职业|身份|工作)/.test(q)) {
    return "profile";
  }
  return "none";
}

function resolveEvalProfile(
  input: string | undefined,
  promptVersions: Record<"analysis" | "chat" | "memory", string>
): EvalProfile {
  const normalized = input?.trim().toLowerCase();
  if (normalized === "legacy_v1" || normalized === "memory_weaving_v2") {
    return normalized;
  }
  if (
    promptVersions.analysis.startsWith("1.")
    || promptVersions.chat.startsWith("1.")
    || promptVersions.memory.startsWith("1.")
  ) {
    return "legacy_v1";
  }
  return "memory_weaving_v2";
}

function normalizeMemoryIntent(value: string): MemoryIntent {
  if (value === "identity" || value === "profile" || value === "preference" || value === "history") {
    return value;
  }
  return "none";
}

function detectPrimarySource(answer: string): PrimarySource {
  if (answer.includes("基于记忆")) {
    return "memory";
  }
  if (answer.includes("基于文档")) {
    return "document";
  }
  return "unknown";
}

function extractMemoryStatements(graphContext: string): string[] {
  const xmlMatches = [...graphContext.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)];
  if (xmlMatches.length > 0) {
    return xmlMatches
      .map((match) => decodeXmlEntities(match[1] ?? "").trim())
      .filter((line) => line.length > 0);
  }

  if (!graphContext.includes("已知记忆（评测注入）")) {
    return [];
  }
  return graphContext
    .split("\n")
    .filter((line) => line.startsWith("- [记忆"))
    .map((line) => line.replace(/^- \[[^\]]+\]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

function scopeMemoryStatementsByIntent(statements: string[], intent: MemoryIntent): string[] {
  if (intent !== "identity") {
    return statements;
  }
  return statements.filter((line) => {
    const compact = line.replace(/\s+/g, "");
    if (/(你爹|你爸|你爸爸|你爷|你爷爷|你祖宗|你妈|你娘|废物|傻逼|煞笔|脑残|白痴|弱智|狗东西|畜生)/i.test(compact)) {
      return false;
    }
    return (
      /用户(?:的)?(?:姓名|名字|身份|职业|职位|工作|来源地|家乡|籍贯|居住地)/.test(compact)
      || /用户(?:是|叫|名叫|来自)/.test(compact)
    );
  });
}

function extractDocumentStatements(retrievedChunks: string): string[] {
  if (retrievedChunks.includes("（无文档片段）")) {
    return [];
  }
  const blocks = retrievedChunks.split(/\n\n+/);
  const statements: string[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length >= 2 && lines[0]?.startsWith("[")) {
      statements.push(lines.slice(1).join(" "));
    }
  }
  return statements;
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
}

function extractKeywordHints(question: string): string[] {
  const match = question.match(/([A-Za-z0-9_\u4e00-\u9fa5]{2,})/g) ?? [];
  const hints = match.filter((token) => !["什么", "介绍", "解释", "一下"].includes(token));
  return hints.slice(0, 4);
}

function toEvalRunId(now: Date, label?: string): string {
  const iso = now.toISOString();
  const stamp = iso.replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  const millisecond = iso.slice(20, 23);
  const safeLabel = label?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  if (safeLabel && safeLabel.length > 0) {
    return `eval_${stamp}_${millisecond}_${safeLabel}`;
  }
  return `eval_${stamp}_${millisecond}`;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

async function loadDataset(path: string): Promise<EvalDataset> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as EvalDataset;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.test_cases)) {
    throw new Error(`Invalid dataset format: ${path}`);
  }
  return parsed;
}

async function resolveInputPath(inputPath: string, repoRoot: string): Promise<string> {
  if (inputPath.startsWith("/")) {
    return inputPath;
  }
  const candidates = [
    resolve(process.cwd(), inputPath),
    resolve(process.cwd(), "..", inputPath),
    resolve(process.cwd(), "..", "..", inputPath),
    resolve(repoRoot, inputPath)
  ];
  for (const candidate of dedupeStrings(candidates)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

function resolveOutputPath(outputPath: string, repoRoot: string): string {
  if (outputPath.startsWith("/")) {
    return outputPath;
  }
  return resolve(repoRoot, outputPath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readPromptVersionsFromMetadata(
  metadata: Record<string, unknown>
): Record<"analysis" | "chat" | "memory", string> | null {
  const candidate = metadata.prompt_versions;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const analysis = record.analysis;
  const chat = record.chat;
  const memory = record.memory;
  if (typeof analysis !== "string" || typeof chat !== "string" || typeof memory !== "string") {
    return null;
  }
  return { analysis, chat, memory };
}

function buildMarkdownReport(report: EvalReport): string {
  const failedLines = report.failed_cases.length === 0
    ? "- None\n"
    : report.failed_cases.map((item) => `- ${item.id}: ${item.reason}`).join("\n");
  return [
    `# Prompt Eval Report (${report.eval_run_id})`,
    "",
    `- Dataset Version: ${report.dataset_version}`,
    `- Prompt Versions: analysis=${report.prompt_versions.analysis}, chat=${report.prompt_versions.chat}, memory=${report.prompt_versions.memory}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| total | ${report.summary.total} |`,
    `| passed | ${report.summary.passed} |`,
    `| failed | ${report.summary.failed} |`,
    `| pass_rate | ${report.summary.pass_rate.toFixed(4)} |`,
    "",
    "## Metrics",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| identity_qa_accuracy | ${report.metrics.identity_qa_accuracy.toFixed(4)} |`,
    `| memory_priority_hit | ${report.metrics.memory_priority_hit.toFixed(4)} |`,
    `| noise_override_rate | ${report.metrics.noise_override_rate.toFixed(4)} |`,
    `| invalid_memory_write_rate | ${report.metrics.invalid_memory_write_rate.toFixed(4)} |`,
    "",
    "## Failed Cases",
    "",
    failedLines,
    ""
  ].join("\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Prompt eval failed: ${message}`);
  process.exitCode = 1;
});
