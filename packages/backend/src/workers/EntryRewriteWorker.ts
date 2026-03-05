import type { ChatMessage, FactReviewStatus } from "@graphen/shared";
import type { Pool } from "pg";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { logger } from "../utils/logger.js";

interface EntryRewriteJobRow {
  id: string;
  entry_id: string;
  entry_revision: number;
  attempts: number;
  max_attempts: number;
}

interface EntryRow {
  id: string;
  content: string;
  content_revision: number;
  review_status: FactReviewStatus;
}

interface RewriteFactRow {
  subject_text: string;
  predicate: string;
  object_value: string;
  confidence: number;
}

export interface EntryRewriteWorkerOptions {
  intervalMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  useLlm?: boolean;
  llmService?: LLMServiceLike;
}

export class EntryRewriteWorker {
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly useLlm: boolean;
  private readonly llmService: LLMServiceLike | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private processing = false;

  constructor(private readonly pgPool: Pool, options: EntryRewriteWorkerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 5_000;
    this.useLlm = options.useLlm ?? false;
    this.llmService = options.llmService;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    logger.info(
      {
        intervalMs: this.intervalMs,
        maxAttempts: this.maxAttempts,
        useLlm: this.useLlm
      },
      "EntryRewriteWorker started"
    );
    void this.tick();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    while (this.processing) {
      await sleep(10);
    }
    logger.info("EntryRewriteWorker stopped");
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }

    this.processing = true;
    try {
      await this.processOneJob();
    } catch (error) {
      logger.error({ err: error }, "EntryRewriteWorker tick failed");
    } finally {
      this.processing = false;
    }
  }

  private async processOneJob(): Promise<void> {
    const job = await this.pickJob();
    if (!job) {
      return;
    }

    try {
      const result = await this.executeJob(job);
      await this.pgPool.query(
        `
          UPDATE entry_rewrite_jobs
          SET status = 'succeeded',
              old_content = $2,
              new_content = $3,
              model = $4,
              confidence = $5,
              last_error = NULL,
              updated_at = NOW(),
              finished_at = NOW()
          WHERE id = $1::uuid
        `,
        [job.id, result.oldContent, result.newContent, result.model, result.confidence]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = Math.max(job.max_attempts, this.maxAttempts);
      if (job.attempts >= maxAttempts) {
        await this.pgPool.query(
          `
            UPDATE entry_rewrite_jobs
            SET status = 'dead',
                last_error = $2,
                updated_at = NOW(),
                finished_at = NOW()
            WHERE id = $1::uuid
          `,
          [job.id, message]
        );
        return;
      }

      const delayMs = this.baseBackoffMs * Math.pow(2, Math.max(0, job.attempts - 1));
      await this.pgPool.query(
        `
          UPDATE entry_rewrite_jobs
          SET status = 'failed',
              last_error = $2,
              next_retry_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
              updated_at = NOW()
          WHERE id = $1::uuid
        `,
        [job.id, message, delayMs]
      );
    }
  }

  private async pickJob(): Promise<EntryRewriteJobRow | null> {
    const client = await this.pgPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<EntryRewriteJobRow>(
        `
          WITH picked AS (
            SELECT id
            FROM entry_rewrite_jobs
            WHERE status IN ('pending', 'failed')
              AND next_retry_at <= NOW()
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE entry_rewrite_jobs j
          SET status = 'running',
              attempts = j.attempts + 1,
              updated_at = NOW()
          FROM picked
          WHERE j.id = picked.id
          RETURNING
            j.id,
            j.entry_id,
            j.entry_revision,
            j.attempts,
            j.max_attempts
        `
      );
      await client.query("COMMIT");
      return result.rows[0] ?? null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async executeJob(job: EntryRewriteJobRow): Promise<{
    oldContent: string;
    newContent: string;
    model: string;
    confidence: number;
  }> {
    const client = await this.pgPool.connect();
    try {
      await client.query("BEGIN");

      const entryResult = await client.query<EntryRow>(
        `
          SELECT id, content, content_revision, review_status
          FROM memory_entries
          WHERE id = $1::uuid
            AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE
        `,
        [job.entry_id]
      );
      const entry = entryResult.rows[0];
      if (!entry) {
        throw new Error(`entry not found: ${job.entry_id}`);
      }
      if (entry.content_revision !== job.entry_revision) {
        throw new Error(
          `stale rewrite job: expected revision=${job.entry_revision}, actual=${entry.content_revision}`
        );
      }
      if (!isRewriteEligible(entry.review_status)) {
        throw new Error(`entry review_status is not rewrite-eligible: ${entry.review_status}`);
      }

      const factResult = await client.query<RewriteFactRow>(
        `
          SELECT
            subject_text,
            predicate,
            COALESCE(object_text, object_node_id, '') AS object_value,
            confidence
          FROM memory_facts
          WHERE entry_id = $1::uuid
            AND deleted_at IS NULL
            AND fact_state = 'active'
          ORDER BY updated_at DESC, created_at DESC
        `,
        [entry.id]
      );
      const facts = factResult.rows;
      if (facts.length === 0) {
        throw new Error("entry has no active facts");
      }

      const rewriteResult = await this.generateRewrite(entry.content, facts);
      const rewritten = rewriteResult.newContent.trim();
      if (rewritten.length === 0) {
        throw new Error("rewritten content is empty");
      }

      await client.query(
        `
          UPDATE memory_entries
          SET content = $2,
              normalized_content_key = $3,
              updated_at = NOW(),
              content_revision = content_revision + 1
          WHERE id = $1::uuid
            AND deleted_at IS NULL
        `,
        [entry.id, rewritten, normalizeForKey(rewritten)]
      );

      await client.query("COMMIT");
      return {
        oldContent: entry.content,
        newContent: rewritten,
        model: rewriteResult.model,
        confidence: rewriteResult.confidence
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async generateRewrite(
    oldContent: string,
    facts: RewriteFactRow[]
  ): Promise<{
    newContent: string;
    model: string;
    confidence: number;
  }> {
    const baseline = this.buildDeterministicRewrite(oldContent, facts);
    if (!this.useLlm || !this.llmService) {
      return {
        newContent: baseline,
        model: "rule-based",
        confidence: averageConfidence(facts)
      };
    }

    const llmRewritten = await this.buildLlmRewrite(oldContent, facts);
    if (llmRewritten.length === 0) {
      return {
        newContent: baseline,
        model: "rule-based-fallback",
        confidence: averageConfidence(facts)
      };
    }

    return {
      newContent: llmRewritten,
      model: "llm-rewrite",
      confidence: averageConfidence(facts)
    };
  }

  private buildDeterministicRewrite(oldContent: string, facts: RewriteFactRow[]): string {
    const sentences = facts
      .map((fact) => `${fact.subject_text}的${fact.predicate}是${fact.object_value}`.trim())
      .filter((item) => item.length > 0);
    if (sentences.length === 0) {
      return oldContent.trim();
    }
    return `${sentences.join("；")}。`;
  }

  private async buildLlmRewrite(oldContent: string, facts: RewriteFactRow[]): Promise<string> {
    const llmService = this.llmService;
    if (!llmService) {
      return "";
    }

    const factsText = facts
      .map((fact, index) => `${index + 1}. ${fact.subject_text} | ${fact.predicate} | ${fact.object_value}`)
      .join("\n");
    const prompt = [
      "请将以下结构化事实整合成一段自然、准确、简洁的记忆文本。",
      "要求：",
      "- 保留全部事实，不新增未提供信息",
      "- 语言自然",
      "- 输出纯文本，不要 Markdown",
      "",
      `原始文本：${oldContent}`,
      "事实列表：",
      factsText
    ].join("\n");

    const messages: ChatMessage[] = [
      {
        id: "entry-rewrite",
        sessionId: "entry-rewrite",
        role: "user",
        content: prompt,
        createdAt: new Date()
      }
    ];

    let output = "";
    for await (const chunk of llmService.chatCompletion(messages, {
      graphContext: "",
      retrievedChunks: ""
    })) {
      output += chunk;
    }

    return output.trim();
  }
}

function isRewriteEligible(status: FactReviewStatus): boolean {
  return status === "confirmed" || status === "modified";
}

function averageConfidence(facts: RewriteFactRow[]): number {
  if (facts.length === 0) {
    return 0;
  }
  const sum = facts.reduce((acc, fact) => acc + fact.confidence, 0);
  return Math.max(0, Math.min(1, sum / facts.length));
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
