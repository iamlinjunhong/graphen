import { useEffect, useMemo, useState } from "react";
import type {
  FactReviewStatus,
  MemoryEntryState,
  MemorySourceType,
} from "@graphen/shared";
import type { MemoryCategory } from "../services/api.js";
import type { MemoryListFilters } from "../stores/useMemoryStore";

type FilterTab = "source" | "category" | "state" | "review";

interface FilterDialogProps {
  open: boolean;
  filters: MemoryListFilters;
  categories: MemoryCategory[];
  isCategoriesLoading?: boolean;
  onApply: (filters: MemoryListFilters) => void;
  onClear: () => void;
  onClose: () => void;
}

const SOURCE_OPTIONS: Array<{ value: MemorySourceType; label: string }> = [
  { value: "document", label: "文档" },
  { value: "chat_user", label: "用户对话" },
  { value: "chat_assistant", label: "助手回复" },
  { value: "manual", label: "手动输入" },
];

const STATE_OPTIONS: Array<{ value: MemoryEntryState; label: string }> = [
  { value: "active", label: "活跃 (active)" },
  { value: "paused", label: "已暂停 (paused)" },
  { value: "archived", label: "已归档 (archived)" },
];

const REVIEW_OPTIONS: Array<{ value: FactReviewStatus; label: string }> = [
  { value: "auto", label: "自动提取 (auto)" },
  { value: "confirmed", label: "已确认 (confirmed)" },
  { value: "modified", label: "已修改 (modified)" },
  { value: "rejected", label: "已拒绝 (rejected)" },
  { value: "conflicted", label: "冲突 (conflicted)" },
];

const TAB_LABELS: Record<FilterTab, string> = {
  source: "来源",
  category: "分类",
  state: "状态",
  review: "审阅",
};

function cloneFilters(filters: MemoryListFilters): MemoryListFilters {
  return {
    sourceTypes: [...filters.sourceTypes],
    categories: [...filters.categories],
    states: [...filters.states],
    reviewStatuses: [...filters.reviewStatuses],
  };
}

function toggleValue<T extends string>(items: T[], value: T): T[] {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value];
}

const EMPTY_FILTERS: MemoryListFilters = {
  sourceTypes: [],
  categories: [],
  states: [],
  reviewStatuses: [],
};

export function FilterDialog({
  open,
  filters,
  categories,
  isCategoriesLoading = false,
  onApply,
  onClear,
  onClose,
}: FilterDialogProps) {
  const [activeTab, setActiveTab] = useState<FilterTab>("source");
  const [draftFilters, setDraftFilters] = useState<MemoryListFilters>(() => cloneFilters(filters));

  const categoryNames = useMemo(
    () => categories.map((category) => category.name),
    [categories]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraftFilters(cloneFilters(filters));
  }, [filters, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const sourceAllSelected = draftFilters.sourceTypes.length === SOURCE_OPTIONS.length;
  const categoryAllSelected = categoryNames.length > 0
    && draftFilters.categories.length === categoryNames.length;

  return (
    <div
      className="memory-filter-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="memory-filter-dialog" role="dialog" aria-modal="true" aria-label="筛选记忆">
        <header className="memory-filter-header">
          <h3>筛选</h3>
          <button type="button" className="memory-filter-close" aria-label="关闭筛选弹窗" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="memory-filter-tabs" role="tablist" aria-label="筛选维度">
          {(Object.keys(TAB_LABELS) as FilterTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              className={`memory-filter-tab${activeTab === tab ? " is-active" : ""}`}
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        <div className="memory-filter-body">
          {activeTab === "source" ? (
            <div className="memory-filter-list">
              <label className="memory-filter-item">
                <input
                  type="checkbox"
                  checked={sourceAllSelected}
                  onChange={(event) => {
                    setDraftFilters((prev) => ({
                      ...prev,
                      sourceTypes: event.currentTarget.checked
                        ? SOURCE_OPTIONS.map((item) => item.value)
                        : [],
                    }));
                  }}
                />
                <span>Select All</span>
              </label>

              {SOURCE_OPTIONS.map((item) => (
                <label key={item.value} className="memory-filter-item">
                  <input
                    type="checkbox"
                    checked={draftFilters.sourceTypes.includes(item.value)}
                    onChange={() => {
                      setDraftFilters((prev) => ({
                        ...prev,
                        sourceTypes: toggleValue(prev.sourceTypes, item.value),
                      }));
                    }}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          ) : null}

          {activeTab === "category" ? (
            <div className="memory-filter-list">
              {isCategoriesLoading ? (
                <p className="memory-filter-empty">分类加载中...</p>
              ) : categoryNames.length === 0 ? (
                <p className="memory-filter-empty">暂无分类</p>
              ) : (
                <>
                  <label className="memory-filter-item">
                    <input
                      type="checkbox"
                      checked={categoryAllSelected}
                      onChange={(event) => {
                        setDraftFilters((prev) => ({
                          ...prev,
                          categories: event.currentTarget.checked ? [...categoryNames] : [],
                        }));
                      }}
                    />
                    <span>Select All</span>
                  </label>

                  {categories.map((category) => (
                    <label key={category.name} className="memory-filter-item">
                      <input
                        type="checkbox"
                        checked={draftFilters.categories.includes(category.name)}
                        onChange={() => {
                          setDraftFilters((prev) => ({
                            ...prev,
                            categories: toggleValue(prev.categories, category.name),
                          }));
                        }}
                      />
                      <span>{category.name}</span>
                      <span className="memory-filter-count">{category.count}</span>
                    </label>
                  ))}
                </>
              )}
            </div>
          ) : null}

          {activeTab === "state" ? (
            <div className="memory-filter-list">
              {STATE_OPTIONS.map((item) => (
                <label key={item.value} className="memory-filter-item">
                  <input
                    type="checkbox"
                    checked={draftFilters.states.includes(item.value)}
                    onChange={() => {
                      setDraftFilters((prev) => ({
                        ...prev,
                        states: toggleValue(prev.states, item.value),
                      }));
                    }}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          ) : null}

          {activeTab === "review" ? (
            <div className="memory-filter-list">
              {REVIEW_OPTIONS.map((item) => (
                <label key={item.value} className="memory-filter-item">
                  <input
                    type="checkbox"
                    checked={draftFilters.reviewStatuses.includes(item.value)}
                    onChange={() => {
                      setDraftFilters((prev) => ({
                        ...prev,
                        reviewStatuses: toggleValue(prev.reviewStatuses, item.value),
                      }));
                    }}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>

        <footer className="memory-filter-footer">
          <button
            type="button"
            className="memory-filter-secondary"
            onClick={() => {
              setDraftFilters({ ...EMPTY_FILTERS });
              onClear();
              onClose();
            }}
          >
            清除全部
          </button>
          <button
            type="button"
            className="memory-filter-primary"
            onClick={() => {
              onApply(cloneFilters(draftFilters));
              onClose();
            }}
          >
            应用筛选
          </button>
        </footer>
      </section>
    </div>
  );
}
