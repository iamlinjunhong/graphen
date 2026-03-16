import { useEffect, useMemo, useState } from "react";
import type { MemoryEntry, MemorySourceType } from "@graphen/shared";
import type { MemoryBatchAction } from "../services/api.js";
import { EMPTY_ENTRY_FACTS, useMemoryStore } from "../stores/useMemoryStore";
import { MemoryToolbar } from "./MemoryToolbar";
import { MemoryPagination } from "./MemoryPagination";
import type { MemoryQuickSourceFilter } from "./MemoryStatsPanel";
import { MemoryTable } from "./MemoryTable";
import type { MemoryRowAction } from "./MemoryTableRow";
import { MemoryTableSkeleton } from "./MemoryTableSkeleton";
import { CreateMemoryDialog } from "./CreateMemoryDialog";
import { UpdateMemoryDialog } from "./UpdateMemoryDialog";
import "../styles/memory-edit-dialog.css";
import "../styles/memory-filter-dialog.css";
import "../styles/memory-detail-panel.css";
import "../styles/memory-pagination.css";
import "../styles/memory-table.css";
import "../styles/memory-toolbar.css";
import "../styles/memory-weaving.css";

const EMPTY_SOURCE_TYPES: MemorySourceType[] = [];

function mapQuickFilterToSourceTypes(filter: MemoryQuickSourceFilter): MemorySourceType[] {
  if (filter === "all") return EMPTY_SOURCE_TYPES;
  if (filter === "document") return ["document"];
  if (filter === "manual") return ["manual"];
  return ["chat_user", "chat_assistant"];
}

function mapSourceTypesToQuickFilter(sourceTypes: MemorySourceType[]): MemoryQuickSourceFilter {
  if (sourceTypes.length === 0) return "all";
  const normalized = [...new Set(sourceTypes)].sort();
  if (normalized.length === 1 && normalized[0] === "document") return "document";
  if (normalized.length === 1 && normalized[0] === "manual") return "manual";
  if (normalized.length === 2 && normalized.includes("chat_user") && normalized.includes("chat_assistant")) return "chat";
  return "all";
}

function getSourceCount(bySourceType: Partial<Record<MemorySourceType, number>>, type: MemorySourceType): number {
  return bySourceType[type] ?? 0;
}

export function MemoryWeavingPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [editingEntry, setEditingEntry] = useState<MemoryEntry | null>(null);
  const [updatingEntry, setUpdatingEntry] = useState(false);

  const entries = useMemoryStore((state) => state.entries);
  const entriesLoadingStatus = useMemoryStore((state) => state.entriesLoadingStatus);
  const entriesError = useMemoryStore((state) => state.entriesError);
  const currentPage = useMemoryStore((state) => state.currentPage);
  const pageSize = useMemoryStore((state) => state.pageSize);
  const totalCount = useMemoryStore((state) => state.totalCount);
  const searchQuery = useMemoryStore((state) => state.searchQuery);
  const filters = useMemoryStore((state) => state.filters);
  const sortColumn = useMemoryStore((state) => state.sortColumn);
  const sortDirection = useMemoryStore((state) => state.sortDirection);
  const selectedIds = useMemoryStore((state) => state.selectedIds);
  const expandedEntryId = useMemoryStore((state) => state.expandedEntryId);
  const entryFactsByEntryId = useMemoryStore((state) => state.entryFactsByEntryId);
  const accessLogsByEntryId = useMemoryStore((state) => state.accessLogsByEntryId);
  const relatedEntriesByEntryId = useMemoryStore((state) => state.relatedEntriesByEntryId);
  const detailLoadingStatus = useMemoryStore((state) => state.detailLoadingStatus);
  const detailErrors = useMemoryStore((state) => state.detailErrors);
  const evidenceByFactId = useMemoryStore((state) => state.evidenceByFactId);
  const categories = useMemoryStore((state) => state.categories);
  const categoriesLoadingStatus = useMemoryStore((state) => state.categoriesLoadingStatus);
  const stats = useMemoryStore((state) => state.stats);
  const statsLoadingStatus = useMemoryStore((state) => state.statsLoadingStatus);
  const statsError = useMemoryStore((state) => state.statsError);

  const setCurrentPage = useMemoryStore((state) => state.setCurrentPage);
  const setPageSize = useMemoryStore((state) => state.setPageSize);
  const setSearchQuery = useMemoryStore((state) => state.setSearchQuery);
  const setFilters = useMemoryStore((state) => state.setFilters);
  const clearFilters = useMemoryStore((state) => state.clearFilters);
  const setSort = useMemoryStore((state) => state.setSort);
  const setSelectedIds = useMemoryStore((state) => state.setSelectedIds);
  const setExpandedEntryId = useMemoryStore((state) => state.setExpandedEntryId);
  const batchUpdateEntries = useMemoryStore((state) => state.batchUpdateEntries);
  const createEntry = useMemoryStore((state) => state.createEntry);
  const updateEntry = useMemoryStore((state) => state.updateEntry);
  const fetchEntries = useMemoryStore((state) => state.fetchEntries);
  const fetchEntryFacts = useMemoryStore((state) => state.fetchEntryFacts);
  const fetchAccessLogs = useMemoryStore((state) => state.fetchAccessLogs);
  const fetchRelatedEntries = useMemoryStore((state) => state.fetchRelatedEntries);
  const loadEvidence = useMemoryStore((state) => state.loadEvidence);
  const fetchStats = useMemoryStore((state) => state.fetchStats);
  const fetchCategories = useMemoryStore((state) => state.fetchCategories);

  const quickSourceFilter = useMemo(
    () => mapSourceTypesToQuickFilter(filters.sourceTypes),
    [filters.sourceTypes]
  );

  useEffect(() => {
    void Promise.all([fetchStats(), fetchCategories()]);
  }, [fetchStats, fetchCategories]);

  useEffect(() => {
    void fetchEntries({ page: currentPage, pageSize });
  }, [currentPage, fetchEntries, filters, pageSize, searchQuery, sortColumn, sortDirection]);

  useEffect(() => {
    if (!expandedEntryId) return;
    void Promise.all([
      fetchEntryFacts(expandedEntryId),
      fetchAccessLogs(expandedEntryId),
      fetchRelatedEntries(expandedEntryId),
    ]);
  }, [expandedEntryId, fetchAccessLogs, fetchEntryFacts, fetchRelatedEntries]);

  const expandedEntryFacts = useMemo(
    () => (expandedEntryId ? entryFactsByEntryId[expandedEntryId] ?? EMPTY_ENTRY_FACTS : EMPTY_ENTRY_FACTS),
    [entryFactsByEntryId, expandedEntryId]
  );

  useEffect(() => {
    if (!expandedEntryId || expandedEntryFacts.length === 0) return;
    for (const fact of expandedEntryFacts) {
      if (evidenceByFactId[fact.id] === undefined) {
        void loadEvidence(fact.id);
      }
    }
  }, [evidenceByFactId, expandedEntryFacts, expandedEntryId, loadEvidence]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allVisibleSelected = entries.length > 0 && entries.every((entry) => selectedIdSet.has(entry.id));
  const someVisibleSelected = entries.some((entry) => selectedIdSet.has(entry.id)) && !allVisibleSelected;

  // Stats derived values
  const documentCount = getSourceCount(stats.bySourceType, "document");
  const chatCount = getSourceCount(stats.bySourceType, "chat_user") + getSourceCount(stats.bySourceType, "chat_assistant");
  const manualCount = getSourceCount(stats.bySourceType, "manual");
  const confirmedCount = stats.byReviewStatus["confirmed"] ?? 0;
  const conflictedCount = stats.byReviewStatus["conflicted"] ?? 0;

  const handleToggleSelected = (entryId: string, checked: boolean): void => {
    if (checked) {
      if (!selectedIdSet.has(entryId)) setSelectedIds([...selectedIds, entryId]);
      return;
    }
    if (selectedIdSet.has(entryId)) setSelectedIds(selectedIds.filter((id) => id !== entryId));
  };

  const handleToggleSelectAll = (checked: boolean): void => {
    if (!checked) { setSelectedIds([]); return; }
    setSelectedIds(entries.map((entry) => entry.id));
  };

  const handleToggleExpanded = (entryId: string): void => {
    setExpandedEntryId(expandedEntryId === entryId ? null : entryId);
  };

  const handleNavigateToEntry = (entryId: string): void => {
    const targetEntry = entries.find((entry) => entry.id === entryId);
    if (!targetEntry) {
      window.alert("目标记忆不在当前页，请调整筛选或翻页后重试。");
      return;
    }
    setExpandedEntryId(targetEntry.id);
    window.setTimeout(() => {
      const row = document.querySelector(`[data-memory-entry-id="${targetEntry.id}"]`);
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 40);
  };

  const handleRetry = (): void => {
    void Promise.all([
      fetchEntries({ page: currentPage, pageSize, force: true }),
      fetchStats({ force: true }),
      fetchCategories({ force: true }),
    ]);
  };

  const handleBatchAction = async (action: MemoryBatchAction): Promise<void> => {
    if (selectedIds.length === 0) return;
    await batchUpdateEntries(selectedIds, action);
  };

  const handleRowAction = async (entry: MemoryEntry, action: MemoryRowAction): Promise<void> => {
    if (action === "edit") { setEditingEntry(entry); return; }
    if (action === "delete") {
      const confirmed = window.confirm(`确认删除记忆 #${entry.id.slice(0, 8)} 吗？`);
      if (!confirmed) return;
    }
    const mappedAction: MemoryBatchAction = action === "unarchive" ? "resume" : action;
    await batchUpdateEntries([entry.id], mappedAction);
  };

  const handleSubmitEdit = async (content: string): Promise<void> => {
    if (!editingEntry) return;
    setUpdatingEntry(true);
    try {
      const updatedEntryId = editingEntry.id;
      const updated = await updateEntry(updatedEntryId, { content, reextract: true, replaceFacts: true });
      if (updated) {
        setEditingEntry(null);
        if (expandedEntryId === updatedEntryId) {
          await Promise.all([
            fetchEntryFacts(updatedEntryId, { force: true }),
            fetchAccessLogs(updatedEntryId, { force: true }),
            fetchRelatedEntries(updatedEntryId, { force: true }),
          ]);
        }
      } else {
        window.alert("保存失败，请稍后重试。");
      }
    } finally {
      setUpdatingEntry(false);
    }
  };

  const handleSubmitCreate = async (content: string): Promise<void> => {
    setCreatingEntry(true);
    try {
      const created = await createEntry({ content, reextract: true });
      if (created) { setCreateDialogOpen(false); }
      else { window.alert("创建失败，请稍后重试。"); }
    } finally {
      setCreatingEntry(false);
    }
  };

  const handleSourceFilterChange = (filter: MemoryQuickSourceFilter): void => {
    setFilters({ sourceTypes: mapQuickFilterToSourceTypes(filter) });
  };

  return (
    <section className="page-shell memory-weaving-shell">
      <div className="memory-weaving-layout">
        {/* Page title */}
        <div className="memory-weaving-header">
          <h2>MemoryWaving</h2>
          {statsLoadingStatus !== "loading" && (
            <span className="memory-total-badge">{stats.total} 条记忆</span>
          )}
        </div>

        {/* Inline stats bar + quick filters */}
        <div className="memory-stats-bar">
          <span className="stat-chip">
            文档 <strong>{documentCount}</strong>
          </span>
          <span className="stat-chip">
            对话 <strong>{chatCount}</strong>
          </span>
          <span className="stat-chip">
            手动 <strong>{manualCount}</strong>
          </span>
          <span className="stat-divider" />
          <span className="stat-chip">
            已确认 <strong>{confirmedCount}</strong>
          </span>
          {conflictedCount > 0 && (
            <span className="stat-chip" style={{ borderColor: "rgba(239, 68, 68, 0.35)" }}>
              冲突 <strong style={{ color: "#ef4444" }}>{conflictedCount}</strong>
            </span>
          )}
          {statsError && <span className="stat-chip" style={{ color: "#9a4d00" }}>统计加载失败</span>}

          <div className="memory-quick-filters-inline">
            <button type="button" className={quickSourceFilter === "all" ? "is-active" : ""} onClick={() => handleSourceFilterChange("all")}>全部</button>
            <button type="button" className={quickSourceFilter === "document" ? "is-active" : ""} onClick={() => handleSourceFilterChange("document")}>文档</button>
            <button type="button" className={quickSourceFilter === "chat" ? "is-active" : ""} onClick={() => handleSourceFilterChange("chat")}>对话</button>
            <button type="button" className={quickSourceFilter === "manual" ? "is-active" : ""} onClick={() => handleSourceFilterChange("manual")}>手动</button>
          </div>
        </div>

        {/* Main content */}
        <div className="memory-weaving-main">
          <MemoryToolbar
            searchQuery={searchQuery}
            filters={filters}
            categories={categories}
            isCategoriesLoading={categoriesLoadingStatus === "loading"}
            selectedCount={selectedIds.length}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSearchChange={(query) => setSearchQuery(query)}
            onSortChange={(column, direction) => setSort(column, direction)}
            onApplyFilters={(nextFilters) => setFilters(nextFilters)}
            onClearFilters={clearFilters}
            onBatchAction={handleBatchAction}
            onCreate={() => setCreateDialogOpen(true)}
            createDisabled={creatingEntry || updatingEntry}
          />

          {entriesError ? (
            <div className="memory-weaving-error">
              <p>{entriesError}</p>
              <button type="button" onClick={handleRetry}>重试</button>
            </div>
          ) : entriesLoadingStatus === "loading" && entries.length === 0 ? (
            <MemoryTableSkeleton />
          ) : (
            <MemoryTable
              entries={entries}
              selectedIds={selectedIdSet}
              allVisibleSelected={allVisibleSelected}
              someVisibleSelected={someVisibleSelected}
              expandedEntryId={expandedEntryId}
              entryFactsByEntryId={entryFactsByEntryId}
              accessLogsByEntryId={accessLogsByEntryId}
              relatedEntriesByEntryId={relatedEntriesByEntryId}
              detailLoadingStatus={detailLoadingStatus}
              detailErrors={detailErrors}
              evidenceByFactId={evidenceByFactId}
              onToggleSelectAll={handleToggleSelectAll}
              onToggleSelected={handleToggleSelected}
              onToggleExpanded={handleToggleExpanded}
              onNavigateToEntry={handleNavigateToEntry}
              onRowAction={handleRowAction}
            />
          )}

          <MemoryPagination
            currentPage={currentPage}
            pageSize={pageSize}
            totalItems={totalCount}
            onPageChange={(page) => setCurrentPage(page)}
            onPageSizeChange={(size) => setPageSize(size)}
          />
        </div>
      </div>

      <CreateMemoryDialog
        open={createDialogOpen}
        isSubmitting={creatingEntry}
        onClose={() => { if (!creatingEntry) setCreateDialogOpen(false); }}
        onSubmit={handleSubmitCreate}
      />

      <UpdateMemoryDialog
        open={editingEntry !== null}
        entry={editingEntry}
        isSubmitting={updatingEntry}
        onClose={() => { if (!updatingEntry) setEditingEntry(null); }}
        onSubmit={handleSubmitEdit}
      />
    </section>
  );
}
