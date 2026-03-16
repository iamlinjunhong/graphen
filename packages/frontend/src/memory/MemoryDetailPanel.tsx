import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { MemoryEntry, MemoryEntryFact, MemoryEvidence } from "@graphen/shared";
import type { MemoryAccessLog } from "../services/api.js";
import { AccessLogTimeline } from "./AccessLogTimeline";
import { CategoryBadges } from "./CategoryBadges";
import { MemoryEvidenceList } from "./MemoryEvidenceList";
import { RelatedMemoryList } from "./RelatedMemoryList";
import { MemoryStatusBadge } from "./MemoryStatusBadge";
import { MemoryDetailActions } from "./MemoryDetailActions";
import type { MemoryRowAction } from "./MemoryTableRow";

interface MemoryDetailPanelProps {
  entry: MemoryEntry;
  facts: MemoryEntryFact[];
  factsLoadingStatus: "idle" | "loading" | "loaded" | "error";
  factsError: string | null;
  evidenceByFactId: Record<string, MemoryEvidence[]>;
  accessLogs: MemoryAccessLog[];
  accessLogsLoadingStatus: "idle" | "loading" | "loaded" | "error";
  accessLogsError: string | null;
  relatedEntries: MemoryEntry[];
  relatedEntriesLoadingStatus: "idle" | "loading" | "loaded" | "error";
  relatedEntriesError: string | null;
  onNavigateToEntry: (entryId: string) => void;
  onAction: (entry: MemoryEntry, action: MemoryRowAction) => void | Promise<void>;
}

const SOURCE_LABELS: Record<MemoryEntry["sourceType"], string> = {
  document: "文档",
  chat_user: "用户对话",
  chat_assistant: "助手回复",
  manual: "手动",
};

const SOURCE_ICONS: Record<MemoryEntry["sourceType"], string> = {
  document: "📄",
  chat_user: "💬",
  chat_assistant: "🤖",
  manual: "✏️",
};

const STATE_LABELS: Record<MemoryEntry["state"], string> = {
  active: "活跃",
  paused: "暂停",
  archived: "归档",
  deleted: "已删除",
};

const objectFirstPredicatePattern = /(姓名|名字|名叫|叫|全名|昵称|称呼)/;

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("zh-CN");
}

function resolveObjectText(fact: MemoryEntryFact): string {
  return fact.objectText?.trim() || fact.objectNodeId?.trim() || "—";
}

function resolveSubjectText(fact: MemoryEntryFact): string {
  return fact.subjectText?.trim() || fact.subjectNodeId?.trim() || "—";
}

function normalizeForGraphKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveSubjectFocusNodeId(fact: MemoryEntryFact): string | null {
  const fromNodeId = fact.subjectNodeId?.trim();
  if (fromNodeId) {
    return fromNodeId;
  }

  const subjectText = fact.subjectText?.trim();
  if (!subjectText) {
    return null;
  }
  return `text:${normalizeForGraphKey(subjectText)}`;
}

function resolveObjectFocusNodeId(fact: MemoryEntryFact): string | null {
  const fromNodeId = fact.objectNodeId?.trim();
  if (fromNodeId) {
    return fromNodeId;
  }

  const objectText = fact.objectText?.trim();
  if (!objectText) {
    return null;
  }
  return `value:${fact.entryId}:${fact.normalizedFactKey}`;
}

function buildGraphHref(fact: MemoryEntryFact): string {
  const subjectNodeId = resolveSubjectFocusNodeId(fact);
  const objectNodeId = resolveObjectFocusNodeId(fact);
  const predicate = fact.predicate.trim();
  const prefersObject = objectFirstPredicatePattern.test(predicate);
  const focusNodeId = prefersObject
    ? (objectNodeId ?? subjectNodeId)
    : (subjectNodeId ?? objectNodeId);

  if (focusNodeId) {
    return `/graph?focusNode=${encodeURIComponent(focusNodeId)}`;
  }
  return "/graph";
}

export function MemoryDetailPanel({
  entry,
  facts,
  factsLoadingStatus,
  factsError,
  evidenceByFactId,
  accessLogs,
  accessLogsLoadingStatus,
  accessLogsError,
  relatedEntries,
  relatedEntriesLoadingStatus,
  relatedEntriesError,
  onNavigateToEntry,
  onAction,
}: MemoryDetailPanelProps) {
  const mergedEvidence = useMemo(() => {
    const seen = new Set<string>();
    const items: MemoryEvidence[] = [];

    for (const fact of facts) {
      const evidenceList = evidenceByFactId[fact.id] ?? [];
      for (const evidence of evidenceList) {
        if (seen.has(evidence.id)) {
          continue;
        }
        seen.add(evidence.id);
        items.push(evidence);
      }
    }

    items.sort((a, b) => Date.parse(b.extractedAt) - Date.parse(a.extractedAt));
    return items;
  }, [evidenceByFactId, facts]);

  return (
    <div className="memory-detail-panel">
      <div className="memory-detail-head">
        <div>
          <p className="memory-detail-kicker">记忆详情</p>
          <h3 className="memory-detail-title">#{entry.id.slice(0, 8)}</h3>
        </div>
        <MemoryStatusBadge status={entry.reviewStatus} />
      </div>

      <div className="memory-detail-layout">
        <div className="memory-detail-main">
          <section className="memory-detail-section">
            <h4>自由文本</h4>
            <p className="memory-detail-content">{entry.content}</p>
          </section>

          <section className="memory-detail-section">
            <h4>提取的知识三元组</h4>
            {factsLoadingStatus === "loading" ? (
              <p className="memory-detail-muted">加载中...</p>
            ) : factsError ? (
              <p className="memory-detail-error">{factsError}</p>
            ) : facts.length === 0 ? (
              <p className="memory-detail-muted">暂无提取到知识三元组</p>
            ) : (
              <ul className="memory-detail-fact-list">
                {facts.map((fact) => (
                  <li key={fact.id} className="memory-detail-fact-item">
                    <div className="memory-detail-fact-triple">
                      <span className="memory-detail-fact-subject">{resolveSubjectText(fact)}</span>
                      <span className="memory-detail-fact-arrow">→</span>
                      <span className="memory-detail-fact-predicate">{fact.predicate}</span>
                      <span className="memory-detail-fact-arrow">→</span>
                      <span className="memory-detail-fact-object">{resolveObjectText(fact)}</span>
                    </div>
                    <div className="memory-detail-fact-meta">
                      <span className="memory-detail-fact-confidence">置信度 {fact.confidence.toFixed(2)}</span>
                      <Link
                        className="memory-detail-graph-link"
                        to={buildGraphHref(fact)}
                        onClick={(event) => event.stopPropagation()}
                      >
                        在图谱中查看
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="memory-detail-side">
          <section className="memory-detail-section">
            <h4>基础信息</h4>
            <div className="memory-detail-meta-grid">
              <div className="memory-detail-meta-item">
                <span className="memory-detail-meta-label">分类</span>
                <CategoryBadges
                  categories={entry.categories}
                  maxVisible={6}
                  emptyLabel="未分类"
                />
              </div>
              <div className="memory-detail-meta-item">
                <span className="memory-detail-meta-label">来源</span>
                <span className="memory-source-pill">
                  <span aria-hidden>{SOURCE_ICONS[entry.sourceType]}</span>
                  <span>{SOURCE_LABELS[entry.sourceType]}</span>
                </span>
              </div>
              <div className="memory-detail-meta-item">
                <span className="memory-detail-meta-label">审核状态</span>
                <MemoryStatusBadge status={entry.reviewStatus} />
              </div>
              <div className="memory-detail-meta-item">
                <span className="memory-detail-meta-label">生命周期</span>
                <span className={`memory-entry-state-badge is-${entry.state}`}>{STATE_LABELS[entry.state]}</span>
              </div>
              <div className="memory-detail-meta-item">
                <span className="memory-detail-meta-label">更新时间</span>
                <span className="memory-detail-meta-value">{formatDateTime(entry.updatedAt)}</span>
              </div>
            </div>
          </section>

          <section className="memory-detail-section">
            <h4>来源证据 ({mergedEvidence.length})</h4>
            <MemoryEvidenceList evidence={mergedEvidence} />
          </section>

          <section className="memory-detail-section">
            <h4>访问日志</h4>
            <AccessLogTimeline
              memoryId={entry.id}
              logs={accessLogs}
              isLoading={accessLogsLoadingStatus === "loading"}
              error={accessLogsError}
            />
          </section>

          <section className="memory-detail-section">
            <h4>相关记忆 ({relatedEntries.filter((item) => item.id !== entry.id).length})</h4>
            <RelatedMemoryList
              memoryId={entry.id}
              relatedEntries={relatedEntries}
              isLoading={relatedEntriesLoadingStatus === "loading"}
              error={relatedEntriesError}
              onClickMemory={onNavigateToEntry}
            />
          </section>
        </aside>
      </div>

      <MemoryDetailActions entry={entry} onAction={onAction} />
    </div>
  );
}
