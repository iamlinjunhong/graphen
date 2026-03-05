import type { MemoryEntry } from "@graphen/shared";

interface RelatedMemoryListProps {
  memoryId: string;
  relatedEntries: MemoryEntry[];
  isLoading: boolean;
  error?: string | null;
  onClickMemory: (entryId: string) => void;
}

function summarizeContent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 72)}...`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

export function RelatedMemoryList({
  memoryId,
  relatedEntries,
  isLoading,
  error = null,
  onClickMemory,
}: RelatedMemoryListProps) {
  const displayEntries = relatedEntries.filter((entry) => entry.id !== memoryId);

  if (isLoading) {
    return <p className="memory-detail-muted">加载中...</p>;
  }

  if (error) {
    return <p className="memory-detail-error">{error}</p>;
  }

  if (displayEntries.length === 0) {
    return <p className="memory-detail-muted">暂无相关记忆</p>;
  }

  return (
    <ul className="memory-related-list" aria-label={`记忆 ${memoryId} 的相关记忆`}>
      {displayEntries.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            className="memory-related-item"
            onClick={() => onClickMemory(entry.id)}
          >
            <p className="memory-related-content">{summarizeContent(entry.content)}</p>
            <div className="memory-related-meta">
              <div className="memory-related-categories">
                {(entry.categories.length > 0 ? entry.categories : ["未分类"]).slice(0, 2).map((category) => (
                  <span key={category} className="memory-category-chip">
                    {category}
                  </span>
                ))}
              </div>
              <span className="memory-related-date">{formatDate(entry.updatedAt)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
