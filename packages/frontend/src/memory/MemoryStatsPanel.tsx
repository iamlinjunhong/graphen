import type { FactReviewStatus, MemorySourceType } from "@graphen/shared";

export type MemoryQuickSourceFilter = "all" | "document" | "chat" | "manual";

export interface MemoryStatsSnapshot {
  total: number;
  byReviewStatus: Partial<Record<FactReviewStatus, number>>;
  bySourceType: Partial<Record<MemorySourceType, number>>;
  byState: Record<string, number>;
}

interface MemoryStatsPanelProps {
  stats: MemoryStatsSnapshot;
  isLoading?: boolean;
  error?: string | null;
  activeSourceFilter: MemoryQuickSourceFilter;
  onSourceFilterChange: (filter: MemoryQuickSourceFilter) => void;
}

const REVIEW_STATUS_ITEMS: Array<{ key: FactReviewStatus; label: string }> = [
  { key: "auto", label: "自动提取" },
  { key: "confirmed", label: "已确认" },
  { key: "modified", label: "已修改" },
  { key: "rejected", label: "已拒绝" },
  { key: "conflicted", label: "冲突" }
];

function getSourceCount(
  bySourceType: Partial<Record<MemorySourceType, number>>,
  type: MemorySourceType
): number {
  return bySourceType[type] ?? 0;
}

export function MemoryStatsPanel({
  stats,
  isLoading = false,
  error = null,
  activeSourceFilter,
  onSourceFilterChange
}: MemoryStatsPanelProps) {
  const documentCount = getSourceCount(stats.bySourceType, "document");
  const chatUserCount = getSourceCount(stats.bySourceType, "chat_user");
  const chatAssistantCount = getSourceCount(stats.bySourceType, "chat_assistant");
  const manualCount = getSourceCount(stats.bySourceType, "manual");
  const chatCount = chatUserCount + chatAssistantCount;

  return (
    <section className="memory-stats-panel">
      <header className="memory-stats-header">
        <h3>记忆统计</h3>
        {isLoading ? <span className="memory-stats-loading">刷新中</span> : null}
      </header>

      {error ? <p className="memory-stats-error">{error}</p> : null}

      <div className="memory-stats-total-card">
        <span className="memory-stats-total-label">总计</span>
        <strong className="memory-stats-total-value">{stats.total}</strong>
      </div>

      <div className="memory-stats-section">
        <h4>审阅状态</h4>
        <ul>
          {REVIEW_STATUS_ITEMS.map((item) => (
            <li key={item.key}>
              <span>{item.label}</span>
              <strong>{stats.byReviewStatus[item.key] ?? 0}</strong>
            </li>
          ))}
        </ul>
      </div>

      <div className="memory-stats-section">
        <h4>来源分布</h4>
        <ul>
          <li>
            <span>文档</span>
            <strong>{documentCount}</strong>
          </li>
          <li>
            <span>对话</span>
            <strong>{chatCount}</strong>
          </li>
          <li>
            <span>手动</span>
            <strong>{manualCount}</strong>
          </li>
        </ul>
      </div>

      <div className="memory-stats-section">
        <h4>快速过滤</h4>
        <div className="memory-quick-filters">
          <button
            type="button"
            className={activeSourceFilter === "all" ? "is-active" : ""}
            onClick={() => onSourceFilterChange("all")}
          >
            全部
          </button>
          <button
            type="button"
            className={activeSourceFilter === "document" ? "is-active" : ""}
            onClick={() => onSourceFilterChange("document")}
          >
            仅文档
          </button>
          <button
            type="button"
            className={activeSourceFilter === "chat" ? "is-active" : ""}
            onClick={() => onSourceFilterChange("chat")}
          >
            仅对话
          </button>
          <button
            type="button"
            className={activeSourceFilter === "manual" ? "is-active" : ""}
            onClick={() => onSourceFilterChange("manual")}
          >
            仅手动
          </button>
        </div>
      </div>
    </section>
  );
}
