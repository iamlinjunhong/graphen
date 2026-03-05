import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { MemoryBatchAction, MemoryCategory } from "../services/api.js";
import type {
  MemoryListFilters,
  MemorySortColumn,
  MemorySortDirection,
} from "../stores/useMemoryStore";
import { BatchActionsDropdown } from "./BatchActionsDropdown";
import { FilterDialog } from "./FilterDialog";
import { SortDropdown } from "./SortDropdown";

interface MemoryToolbarProps {
  searchQuery: string;
  filters: MemoryListFilters;
  categories: MemoryCategory[];
  isCategoriesLoading?: boolean;
  selectedCount: number;
  sortColumn: MemorySortColumn;
  sortDirection: MemorySortDirection;
  onSearchChange: (query: string) => void;
  onSortChange: (column: MemorySortColumn, direction: MemorySortDirection) => void;
  onApplyFilters: (filters: MemoryListFilters) => void;
  onClearFilters: () => void;
  onBatchAction: (action: MemoryBatchAction) => void | Promise<void>;
  onCreate: () => void;
  createDisabled?: boolean;
}

function countActiveFilters(filters: MemoryListFilters): number {
  return (
    filters.sourceTypes.length
    + filters.categories.length
    + filters.states.length
    + filters.reviewStatuses.length
  );
}

export function MemoryToolbar({
  searchQuery,
  filters,
  categories,
  isCategoriesLoading = false,
  selectedCount,
  sortColumn,
  sortDirection,
  onSearchChange,
  onSortChange,
  onApplyFilters,
  onClearFilters,
  onBatchAction,
  onCreate,
  createDisabled = false,
}: MemoryToolbarProps) {
  const [searchInput, setSearchInput] = useState(searchQuery);
  const [filterOpen, setFilterOpen] = useState(false);

  const selectedLabel = useMemo(
    () => (selectedCount > 0 ? `已选 ${selectedCount} 条` : ""),
    [selectedCount]
  );
  const filterCount = useMemo(() => countActiveFilters(filters), [filters]);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const normalized = searchInput.trim();
      if (normalized !== searchQuery) {
        onSearchChange(normalized);
      }
    }, 500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [onSearchChange, searchInput, searchQuery]);

  return (
    <>
      <div className="memory-toolbar">
        <div className="memory-toolbar-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="搜索记忆..."
            aria-label="搜索记忆"
            value={searchInput}
            onChange={(event) => setSearchInput(event.currentTarget.value)}
          />
          {searchInput.length > 0 ? (
            <button
              type="button"
              className="memory-toolbar-clear"
              aria-label="清除搜索内容"
              onClick={() => {
                setSearchInput("");
                onSearchChange("");
              }}
            >
              清除
            </button>
          ) : null}
        </div>

        <div className="memory-toolbar-actions">
          <button
            type="button"
            className="memory-toolbar-button"
            onClick={() => setFilterOpen(true)}
          >
            筛选 {filterCount > 0 ? `(${filterCount})` : ""}
          </button>

          <SortDropdown
            column={sortColumn}
            direction={sortDirection}
            onChange={onSortChange}
          />

          {selectedCount > 0 ? (
            <BatchActionsDropdown selectedCount={selectedCount} onAction={onBatchAction} />
          ) : null}

          <button
            type="button"
            className="memory-toolbar-create"
            onClick={onCreate}
            disabled={createDisabled}
          >
            + 新建记忆
          </button>
        </div>
      </div>

      {selectedLabel ? <p className="memory-toolbar-selection">{selectedLabel}</p> : null}

      <FilterDialog
        open={filterOpen}
        filters={filters}
        categories={categories}
        isCategoriesLoading={isCategoriesLoading}
        onApply={onApplyFilters}
        onClear={onClearFilters}
        onClose={() => setFilterOpen(false)}
      />
    </>
  );
}
