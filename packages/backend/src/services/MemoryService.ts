import { randomUUID } from "node:crypto";
import type {
  CandidateFact,
  MemoryEntryCreateMetadata,
  MemoryEntryStoreLike,
  MemoryEntryUpdateMetadata,
  MemoryEntryWithFacts,
  MemoryFact,
  MemoryServiceLike,
  MemoryStoreLike,
  MergeResult,
  ReviewAction,
} from "@graphen/shared";

export class MemoryService implements MemoryServiceLike {
  constructor(
    private readonly entryStore: MemoryEntryStoreLike,
    private readonly store?: MemoryStoreLike
  ) {}

  /**
   * 批量合并候选事实。
   * 合并规则（参考设计文档 §8.2）：
   *  - normalizedKey 命中已有 fact → 更新 lastSeenAt，追加 evidence，加权更新 confidence
   *  - normalizedKey 未命中 → 新建 fact，status=auto
   *  - 已有 fact 为 confirmed/modified → 只追加 evidence，不覆盖用户编辑的字段
   *  - 同一 (subject, predicate) 出现互斥 object → 标记 conflicted
   */
  mergeFacts(candidates: CandidateFact[]): MergeResult {
    const store = this.store;
    if (!store) {
      // PG entry/fact flow should use entryStore APIs directly.
      return { created: 0, updated: 0, conflicted: 0 };
    }

    let created = 0;
    let updated = 0;
    let conflicted = 0;

    for (const candidate of candidates) {
      const normalizedKey = this.buildNormalizedKey(candidate);
      const existing = store.getFactByNormalizedKey(normalizedKey);
      const now = new Date().toISOString();

      if (existing) {
        // 已有 fact — 追加 evidence + 更新元数据
        store.addEvidence({
          factId: existing.id,
          ...candidate.evidence,
        });

        const isUserEdited = existing.reviewStatus === "confirmed" || existing.reviewStatus === "modified";
        if (!isUserEdited) {
          // 加权更新 confidence: 取已有和新值的加权平均，偏向更高值
          const newConfidence = Math.min(1, existing.confidence * 0.6 + candidate.confidence * 0.4);
          store.updateFact(existing.id, {
            confidence: Math.round(newConfidence * 1000) / 1000,
            lastSeenAt: now,
          });
        } else {
          // 用户编辑过的 fact 只更新 lastSeenAt
          store.updateFact(existing.id, { lastSeenAt: now });
        }
        updated++;
      } else {
        // 检查冲突：同一 (subject, predicate) 是否已有不同 object
        const conflictStatus = this.detectConflict(candidate);

        const factId = randomUUID();
        store.createFact({
          id: factId,
          subjectNodeId: candidate.subjectNodeId,
          predicate: candidate.predicate,
          ...(candidate.objectNodeId !== undefined ? { objectNodeId: candidate.objectNodeId } : {}),
          ...(candidate.objectText !== undefined ? { objectText: candidate.objectText } : {}),
          valueType: candidate.valueType,
          normalizedKey,
          confidence: candidate.confidence,
          reviewStatus: conflictStatus ? "conflicted" : "auto",
          firstSeenAt: now,
          lastSeenAt: now,
        });

        store.addEvidence({
          factId,
          ...candidate.evidence,
        });

        if (conflictStatus) {
          // 将已有的冲突 fact 也标记为 conflicted
          if (conflictStatus.existingFactId) {
            const existingFact = store.getFactById(conflictStatus.existingFactId);
            if (existingFact && existingFact.reviewStatus === "auto") {
              store.updateFact(conflictStatus.existingFactId, {
                reviewStatus: "conflicted",
              });
            }
          }
          conflicted++;
        } else {
          created++;
        }
      }
    }

    return { created, updated, conflicted };
  }

  /**
   * 审阅事实：确认/拒绝/解决冲突
   */
  reviewFact(factId: string, action: ReviewAction, note?: string): MemoryFact | null {
    if (!this.store) {
      return null;
    }
    const fact = this.store.getFactById(factId);
    if (!fact) return null;

    const statusMap: Record<ReviewAction, MemoryFact["reviewStatus"]> = {
      confirm: "confirmed",
      reject: "rejected",
      resolve: "confirmed", // 解决冲突 = 确认当前值
    };

    const reviewNote = note ?? fact.reviewNote;
    return this.store.updateFact(factId, {
      reviewStatus: statusMap[action],
      ...(reviewNote !== undefined ? { reviewNote } : {}),
    });
  }

  /**
   * 按关联节点 ID 检索相关记忆（用于对话上下文注入）。
   * 排除 rejected 状态的 facts，按 confidence DESC, lastSeenAt DESC 排序。
   */
  retrieveRelevant(nodeIds: string[], limit = 10): MemoryFact[] {
    if (!this.store) {
      return [];
    }
    if (nodeIds.length === 0) return [];

    const allFacts: MemoryFact[] = [];
    const seenIds = new Set<string>();

    for (const nodeId of nodeIds) {
      const facts = this.store.getFactsByNodeId(nodeId, limit);
      for (const fact of facts) {
        if (!seenIds.has(fact.id) && fact.reviewStatus !== "rejected") {
          seenIds.add(fact.id);
          allFacts.push(fact);
        }
      }
    }

    // 按 confidence DESC, lastSeenAt DESC 排序，取 top-N
    allFacts.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });

    return allFacts.slice(0, limit);
  }

  /**
   * 将记忆格式化为 LLM prompt 文本。
   * 格式参考设计文档 §7.3。
   */
  buildMemoryContextText(facts: MemoryFact[]): string {
    if (facts.length === 0) return "";

    const lines = facts.map((fact) => {
      const object = fact.objectText ?? fact.objectNodeId ?? "?";
      const status = fact.reviewStatus;
      return `- [${status}] ${fact.subjectNodeId} 的 ${fact.predicate} 是 ${object}（置信度: ${fact.confidence.toFixed(2)}）`;
    });

    return `已知记忆（跨会话累积的事实）：\n${lines.join("\n")}`;
  }

  async createEntry(
    content: string,
    metadata: MemoryEntryCreateMetadata = {}
  ): Promise<MemoryEntryWithFacts["entry"]> {
    return this.entryStore.createEntry(content, metadata.embedding, metadata);
  }

  async updateEntry(
    id: string,
    content: string,
    metadata: MemoryEntryUpdateMetadata = {}
  ): Promise<MemoryEntryWithFacts["entry"] | null> {
    return this.entryStore.updateEntry(id, content, metadata.embedding, metadata);
  }

  async getEntryWithFacts(id: string): Promise<MemoryEntryWithFacts | null> {
    const entry = await this.entryStore.getEntry(id);
    if (!entry) {
      return null;
    }
    const facts = await this.entryStore.getEntryFacts(id);
    return { entry, facts };
  }

  // --- Private helpers ---

  /**
   * 构建标准化去重键。
   * 复用 EntityResolver.normalizeName 的逻辑：lowercase, trim, 合并空格。
   */
  private buildNormalizedKey(candidate: CandidateFact): string {
    const subject = this.normalize(candidate.subjectNodeId);
    const predicate = this.normalize(candidate.predicate);
    const object = this.normalize(candidate.objectText ?? candidate.objectNodeId ?? "");
    return `${subject}|${predicate}|${object}`;
  }

  private normalize(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
  }

  /**
   * 冲突检测：同一 (subject, predicate) 是否已有不同 object。
   * 只检查 auto 状态的 facts（用户确认过的不算冲突）。
   */
  private detectConflict(candidate: CandidateFact): { existingFactId: string } | null {
    if (!this.store) {
      return null;
    }
    const facts = this.store.getFactsByNodeId(candidate.subjectNodeId, 100);
    const candidatePredicate = this.normalize(candidate.predicate);
    const candidateObject = this.normalize(candidate.objectText ?? candidate.objectNodeId ?? "");

    for (const fact of facts) {
      if (this.normalize(fact.predicate) !== candidatePredicate) continue;
      if (fact.reviewStatus === "rejected") continue;

      const existingObject = this.normalize(fact.objectText ?? fact.objectNodeId ?? "");
      if (existingObject !== candidateObject) {
        return { existingFactId: fact.id };
      }
    }

    return null;
  }
}
