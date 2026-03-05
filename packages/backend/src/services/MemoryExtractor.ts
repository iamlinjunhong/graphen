import type {
  CandidateFact,
  MemoryEntryFact,
  MemoryEntryCreateMetadata,
  MemoryEntryStoreLike,
  MemoryEntryUpsertFactInput,
  MemoryServiceLike,
  MemorySourceType,
  MergeResult
} from "@graphen/shared";
import type { Pool } from "pg";
import { z } from "zod";
import type { LLMServiceLike } from "./llmTypes.js";
import {
  MEMORY_PROMPT_VERSION,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  buildMemoryExtractionUserPrompt,
} from "../prompts/memoryPrompt.js";
import { buildMemoryEvidenceHash } from "../utils/memoryEvidence.js";
import { logger } from "../utils/logger.js";
import { recordMemoryOperationalMetric } from "../utils/memoryOperationalMetrics.js";

/** Raw fact from LLM JSON output */
interface RawExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  valueType: "entity" | "text" | "number" | "date";
  confidence: number;
}

export interface ExtractionResultV2 {
  should_store: boolean;
  entry_summary: string;
  facts: RawExtractedFact[];
  rejection_reason: string;
}

const extractedFactSchema = z.object({
  subject: z.string().default(""),
  predicate: z.string().default(""),
  object: z.string().default(""),
  valueType: z.enum(["entity", "text", "number", "date"]).default("text"),
  confidence: z.number().min(0).max(1).default(0.8)
});

const extractionResultV2Schema = z.object({
  should_store: z.boolean().default(true),
  entry_summary: z.string().default(""),
  facts: z.array(extractedFactSchema).default([]),
  rejection_reason: z.string().default("")
});

/** Extraction task queued for async processing */
interface ExtractionTask {
  message: string;
  sourceType: MemorySourceType;
  chatSessionId?: string;
  chatMessageId?: string;
  documentId?: string;
  chunkId?: string;
  /** Maps subject names to node IDs (from graph context) */
  nodeIdMap?: Map<string, string>;
  resolve: (result: MergeResult) => void;
  reject: (error: Error) => void;
}

export interface MemoryExtractorOptions {
  /** Minimum confidence to accept an extracted fact (default: 0.5) */
  minConfidence?: number;
  /** Confidence multiplier for assistant messages (default: 0.3) */
  assistantConfidenceMultiplier?: number;
}

export class MemoryExtractor {
  private readonly queue: ExtractionTask[] = [];
  private processing = false;
  private readonly minConfidence: number;
  private readonly assistantConfidenceMultiplier: number;
  private readonly entryStore: MemoryEntryStoreLike | undefined;
  private readonly pgPool: Pool | undefined;

  constructor(
    private readonly llmService: LLMServiceLike,
    private readonly memoryService: MemoryServiceLike,
    options: MemoryExtractorOptions = {},
    deps?: { entryStore?: MemoryEntryStoreLike; pgPool?: Pool }
  ) {
    this.minConfidence = options.minConfidence ?? 0.5;
    this.assistantConfidenceMultiplier = options.assistantConfidenceMultiplier ?? 0.3;
    this.entryStore = deps?.entryStore;
    this.pgPool = deps?.pgPool;
  }

  /**
   * Enqueue a message for async fact extraction.
   * Returns a promise that resolves when extraction + merge completes.
   * Does not block the caller — processing happens via microtask queue.
   */
  enqueue(input: {
    message: string;
    sourceType: MemorySourceType;
    chatSessionId?: string;
    chatMessageId?: string;
    documentId?: string;
    chunkId?: string;
    nodeIdMap?: Map<string, string>;
  }): Promise<MergeResult> {
    return new Promise<MergeResult>((resolve, reject) => {
      this.queue.push({ ...input, resolve, reject });
      this.scheduleProcessing();
    });
  }

  /** Number of tasks waiting in the queue */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Whether the extractor is currently processing a task */
  get isProcessing(): boolean {
    return this.processing;
  }

  // --- Internal processing ---

  private scheduleProcessing(): void {
    if (this.processing) return;
    // Use setImmediate-style scheduling to not block the event loop
    Promise.resolve().then(() => this.processNext());
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const task = this.queue.shift()!;

    try {
      const result = await this.processTask(task);
      task.resolve(result);
      await this.recordDocumentExtractionMetric(task.sourceType, "success");
    } catch (error) {
      logger.error({ err: error }, "MemoryExtractor: extraction failed");
      await this.recordDocumentExtractionMetric(task.sourceType, "failure");
      task.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        this.scheduleProcessing();
      }
    }
  }

  private async processTask(task: ExtractionTask): Promise<MergeResult> {
    const extraction = await this.extractFacts(task.message);
    if (!extraction.should_store) {
      logger.info(
        {
          sourceType: task.sourceType,
          rejectionReason: extraction.rejection_reason || "should_store=false",
          chatSessionId: task.chatSessionId,
          chatMessageId: task.chatMessageId,
          documentId: task.documentId,
          chunkId: task.chunkId
        },
        "MemoryExtractor: skipped message storage due to should_store=false"
      );
      return { created: 0, updated: 0, conflicted: 0 };
    }

    const lowQualityReason = detectLowQualityIdentityReason(task.message, extraction.facts);
    if (lowQualityReason) {
      logger.info(
        {
          sourceType: task.sourceType,
          rejectionReason: lowQualityReason,
          chatSessionId: task.chatSessionId,
          chatMessageId: task.chatMessageId,
          documentId: task.documentId,
          chunkId: task.chunkId
        },
        "MemoryExtractor: skipped message storage due to low-quality identity expression"
      );
      return { created: 0, updated: 0, conflicted: 0 };
    }

    const rawFacts = extraction.facts;
    const isAssistant = task.sourceType === "chat_assistant";

    if (this.entryStore) {
      const facts = this.buildEntryFacts(rawFacts, task, isAssistant);
      if (facts.length === 0) {
        return { created: 0, updated: 0, conflicted: 0 };
      }

      const metadata: MemoryEntryCreateMetadata = {
        sourceType: task.sourceType
      };
      const entryEmbedding = await this.generateEntryEmbedding(task);
      if (entryEmbedding.length > 0) {
        metadata.embedding = entryEmbedding;
      }

      const entryContent = extraction.entry_summary.trim().length > 0
        ? extraction.entry_summary.trim()
        : task.message;
      const entry = await this.memoryService.createEntry(entryContent, metadata);
      const upserted = await this.entryStore.upsertFacts(entry.id, facts);
      await this.persistEvidence(task, upserted.facts);
      return {
        created: upserted.created,
        updated: upserted.updated,
        conflicted: 0
      };
    }

    // Apply confidence multiplier for assistant messages
    const candidates: CandidateFact[] = [];

    for (const raw of rawFacts) {
      let confidence = raw.confidence;
      if (isAssistant) {
        confidence *= this.assistantConfidenceMultiplier;
      }
      if (confidence < this.minConfidence) continue;

      // Resolve subject name to node ID if mapping available
      const subjectNodeId = task.nodeIdMap?.get(raw.subject) ?? raw.subject;

      const evidence: CandidateFact["evidence"] = {
        sourceType: task.sourceType,
        excerpt: task.message.slice(0, 200),
        extractedAt: new Date().toISOString(),
      };
      if (task.chatSessionId) {
        evidence.chatSessionId = task.chatSessionId;
      }
      if (task.chatMessageId) {
        evidence.chatMessageId = task.chatMessageId;
      }
      if (task.documentId) {
        evidence.documentId = task.documentId;
      }
      if (task.chunkId) {
        evidence.chunkId = task.chunkId;
      }

      const candidate: CandidateFact = {
        subjectNodeId,
        predicate: raw.predicate,
        valueType: raw.valueType,
        confidence,
        evidence,
      };

      // Set object field based on valueType
      if (raw.valueType === "entity") {
        candidate.objectNodeId = task.nodeIdMap?.get(raw.object) ?? raw.object;
      } else {
        candidate.objectText = raw.object;
      }

      candidates.push(candidate);
    }

    if (candidates.length === 0) {
      return { created: 0, updated: 0, conflicted: 0 };
    }

    return this.memoryService.mergeFacts(candidates);
  }

  private buildEntryFacts(
    rawFacts: RawExtractedFact[],
    task: ExtractionTask,
    isAssistant: boolean
  ): MemoryEntryUpsertFactInput[] {
    const facts: MemoryEntryUpsertFactInput[] = [];

    for (const raw of rawFacts) {
      let confidence = raw.confidence;
      if (isAssistant) {
        confidence *= this.assistantConfidenceMultiplier;
      }
      if (confidence < this.minConfidence) {
        continue;
      }

      const subjectText = raw.subject.trim();
      const predicate = raw.predicate.trim();
      const objectText = raw.object.trim();
      if (subjectText.length === 0 || predicate.length === 0 || objectText.length === 0) {
        continue;
      }

      const subjectNodeId = task.nodeIdMap?.get(raw.subject);
      const fact: MemoryEntryUpsertFactInput = {
        subjectText,
        predicate,
        valueType: raw.valueType,
        confidence
      };
      if (subjectNodeId) {
        fact.subjectNodeId = subjectNodeId;
      }

      if (raw.valueType === "entity") {
        fact.objectNodeId = task.nodeIdMap?.get(raw.object) ?? raw.object;
        fact.objectText = objectText;
      } else {
        fact.objectText = objectText;
      }

      facts.push(fact);
    }

    return facts;
  }

  /**
   * Call LLM to extract structured facts from a message.
   * Returns parsed facts or empty array on failure.
   */
  private async extractFacts(message: string): Promise<ExtractionResultV2> {
    const userPrompt = buildMemoryExtractionUserPrompt(message);

    // Use chatCompletion to get the response (collect all deltas)
    let content = "";
    for await (const delta of this.llmService.chatCompletion(
      [{ id: "", sessionId: "", role: "user", content: userPrompt, createdAt: new Date() }],
      { graphContext: MEMORY_EXTRACTION_SYSTEM_PROMPT, retrievedChunks: "" },
      { promptName: "memory", promptVersion: MEMORY_PROMPT_VERSION }
    )) {
      content += delta;
    }

    return this.parseExtractedFacts(content);
  }

  private async generateEntryEmbedding(task: ExtractionTask): Promise<number[]> {
    try {
      const options = task.documentId ? { documentId: task.documentId } : undefined;
      const embedding = await this.llmService.generateEmbedding(task.message, options);
      return Array.isArray(embedding) ? embedding : [];
    } catch (error) {
      logger.warn({ err: error }, "MemoryExtractor: failed to generate entry embedding");
      return [];
    }
  }

  private async persistEvidence(task: ExtractionTask, facts: MemoryEntryFact[]): Promise<void> {
    if (!this.pgPool || facts.length === 0) {
      return;
    }

    const excerpt = task.message.trim().slice(0, 500) || null;
    const extractedAt = new Date().toISOString();
    let insertedCount = 0;
    let deduplicatedCount = 0;
    let failedCount = 0;
    for (const fact of facts) {
      const evidenceHash = buildMemoryEvidenceHash({
        sourceType: task.sourceType,
        documentId: task.documentId ?? null,
        chunkId: task.chunkId ?? null,
        chatSessionId: task.chatSessionId ?? null,
        chatMessageId: task.chatMessageId ?? null,
        excerpt
      });

      try {
        const result = await this.pgPool.query(
          `
            INSERT INTO memory_evidence (
              fact_id,
              entry_id,
              source_type,
              evidence_hash,
              document_id,
              chunk_id,
              chat_session_id,
              chat_message_id,
              excerpt,
              extracted_at
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10::timestamptz
            )
            ON CONFLICT (fact_id, evidence_hash)
            WHERE evidence_hash IS NOT NULL
            DO NOTHING
            RETURNING id
          `,
          [
            fact.id,
            fact.entryId,
            task.sourceType,
            evidenceHash,
            task.documentId ?? null,
            task.chunkId ?? null,
            task.chatSessionId ?? null,
            task.chatMessageId ?? null,
            excerpt,
            extractedAt
          ]
        );
        if ((result.rowCount ?? 0) > 0) {
          insertedCount += 1;
        } else {
          deduplicatedCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        logger.warn(
          { err: error, factId: fact.id, entryId: fact.entryId },
          "MemoryExtractor: failed to persist memory evidence"
        );
      }
    }

    await recordMemoryOperationalMetric(this.pgPool, {
      metricName: "memory_evidence_write",
      sourceType: task.sourceType,
      outcome: "success",
      count: insertedCount
    });
    await recordMemoryOperationalMetric(this.pgPool, {
      metricName: "memory_evidence_write",
      sourceType: task.sourceType,
      outcome: "deduplicated",
      count: deduplicatedCount
    });
    await recordMemoryOperationalMetric(this.pgPool, {
      metricName: "memory_evidence_write",
      sourceType: task.sourceType,
      outcome: "failure",
      count: failedCount
    });
  }

  private async recordDocumentExtractionMetric(
    sourceType: MemorySourceType,
    outcome: "success" | "failure"
  ): Promise<void> {
    if (sourceType !== "document") {
      return;
    }

    await recordMemoryOperationalMetric(this.pgPool, {
      metricName: "document_memory_extraction",
      sourceType,
      outcome,
      count: 1
    });
  }

  private parseExtractedFacts(content: string): ExtractionResultV2 {
    try {
      // Try to extract JSON from the response (handle markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          should_store: false,
          entry_summary: "",
          facts: [],
          rejection_reason: "模型输出未包含合法 JSON"
        };
      }

      const parsed = extractionResultV2Schema.parse(JSON.parse(jsonMatch[0]));
      const normalizedFacts = parsed.facts
        .map(normalizeExtractedFact)
        .filter((fact) => fact.subject.length > 0 && fact.predicate.length > 0 && fact.object.length > 0);

      if (!parsed.should_store) {
        return {
          should_store: false,
          entry_summary: "",
          facts: [],
          rejection_reason: parsed.rejection_reason.trim() || "模型判定当前消息不应入库"
        };
      }

      return {
        should_store: true,
        entry_summary: parsed.entry_summary.trim(),
        facts: normalizedFacts,
        rejection_reason: ""
      };
    } catch (error) {
      logger.warn({ err: error }, "MemoryExtractor: failed to parse LLM response");
      return {
        should_store: false,
        entry_summary: "",
        facts: [],
        rejection_reason: "模型输出解析失败"
      };
    }
  }
}

const userSubjectAliases = new Set([
  "我",
  "我自己",
  "本人",
  "咱",
  "俺",
  "你",
  "你自己",
  "您",
  "您自己",
  "用户"
]);

const occupationKeywords = [
  "工程师",
  "经理",
  "开发",
  "设计师",
  "研究员",
  "顾问",
  "分析师",
  "教师",
  "老师",
  "医生",
  "护士",
  "学生",
  "总监",
  "架构师",
  "产品",
  "运营",
  "销售",
  "cto",
  "ceo",
  "cfo"
];

const lowQualityIdentityMessagePattern = /(?:^|[，。！？\s])(我是|我就是|老子是)\s*你(爹|爸|爸爸|爷|爷爷|祖宗|妈|娘)(?:[，。！？\s]|$)/i;

const lowQualityIdentityObjectPattern = /(你爹|你爸|你爸爸|你爷|你爷爷|你祖宗|你妈|你娘|废物|傻逼|煞笔|脑残|白痴|弱智|狗东西|畜生)/i;

const identityPredicatePattern = /(身份|姓名|名字|职业|职位|工作|来源地)/;

function normalizeExtractedFact(raw: RawExtractedFact): RawExtractedFact {
  const subject = normalizeSubject(raw.subject);
  const object = normalizeObject(raw.object);
  const predicate = normalizePredicate(raw.predicate, object, subject);
  return {
    ...raw,
    subject,
    predicate,
    object
  };
}

function detectLowQualityIdentityReason(message: string, facts: RawExtractedFact[]): string | null {
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return null;
  }
  if (lowQualityIdentityMessagePattern.test(normalizedMessage)) {
    return "低质量挑衅身份表达";
  }

  for (const fact of facts) {
    if (fact.subject !== "用户") {
      continue;
    }
    if (!identityPredicatePattern.test(fact.predicate)) {
      continue;
    }
    if (lowQualityIdentityObjectPattern.test(fact.object)) {
      return "低质量身份客体";
    }
  }

  return null;
}

function normalizeSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const compact = trimmed.replace(/\s+/g, "").toLowerCase();
  if (userSubjectAliases.has(compact)) {
    return "用户";
  }
  return trimmed;
}

function normalizeObject(object: string): string {
  return object.trim().replace(/[。！？!?]+$/g, "");
}

function normalizePredicate(predicate: string, object: string, subject: string): string {
  const trimmed = predicate.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (subject !== "用户") {
    return trimmed;
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (/姓名|名字|名叫|叫|全名/.test(compact)) {
    return "姓名";
  }
  if (/职业|职位|岗位|工种|工作/.test(compact)) {
    return "职业";
  }
  if (/身份|角色/.test(compact)) {
    return "身份";
  }
  if (/来自|籍贯|家乡|出生地|来源地|居住地/.test(compact)) {
    return "来源地";
  }
  if (/偏好|喜欢|不喜欢|讨厌|爱好/.test(compact)) {
    return "偏好";
  }
  if (compact === "是") {
    const normalizedObject = object.toLowerCase();
    if (occupationKeywords.some((keyword) => normalizedObject.includes(keyword))) {
      return "职业";
    }
    return "身份";
  }

  return trimmed;
}
