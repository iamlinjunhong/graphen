import { create } from "zustand";
import type {
  FactReviewStatus,
  FactValueType,
  MemoryEntry,
  MemoryEntryCreateMetadata,
  MemoryEntryFact,
  MemoryEntrySearchFilters,
  MemoryEntryState,
  MemoryEntryUpdateMetadata,
  MemoryEntryUpsertFactInput,
  MemoryEvidence,
  MemoryFact,
  MemorySourceType,
  ReviewAction,
} from "@graphen/shared";
import { apiClient } from "../services/api.js";
import type {
  MemoryAccessLog,
  MemoryBatchAction,
  MemoryCategory,
} from "../services/api.js";

// Stable empty arrays to avoid infinite re-renders with Zustand selectors
export const EMPTY_FACTS: MemoryFact[] = [];
export const EMPTY_EVIDENCE: MemoryEvidence[] = [];
export const EMPTY_ENTRIES: MemoryEntry[] = [];
export const EMPTY_ENTRY_FACTS: MemoryEntryFact[] = [];
export const EMPTY_ACCESS_LOGS: MemoryAccessLog[] = [];
export const EMPTY_RELATED_ENTRIES: MemoryEntry[] = [];
export const EMPTY_CATEGORIES: MemoryCategory[] = [];
export const EMPTY_SELECTED_IDS: string[] = [];

// --- Types ---

export type MemoryLoadingStatus = "idle" | "loading" | "loaded" | "error";
export type MemorySortColumn = "content" | "sourceType" | "createdAt" | "updatedAt" | "lastSeenAt";
export type MemorySortDirection = "asc" | "desc";

export interface MemoryListFilters {
  sourceTypes: MemorySourceType[];
  categories: string[];
  states: MemoryEntryState[];
  reviewStatuses: FactReviewStatus[];
}

export interface MemoryStatsSnapshot {
  total: number;
  byReviewStatus: Partial<Record<FactReviewStatus, number>>;
  bySourceType: Partial<Record<MemorySourceType, number>>;
  byState: Record<string, number>;
}

interface MemoryState {
  // Facts indexed by node ID (for NodeDetailPanel)
  factsByNodeId: Record<string, MemoryFact[]>;
  // Facts indexed by document ID (for DocumentMemoryPanel)
  factsByDocumentId: Record<string, MemoryFact[]>;
  // Facts indexed by chat session ID (for ChatMemoryIndicator)
  factsByChatSessionId: Record<string, MemoryFact[]>;
  // Evidence indexed by fact ID
  evidenceByFactId: Record<string, MemoryEvidence[]>;
  // Loading status per key
  loadingStatus: Record<string, MemoryLoadingStatus>;
  // Error messages per key
  errors: Record<string, string>;

  // All facts (legacy memory page & side panels)
  allFacts: MemoryFact[];
  allFactsLoadingStatus: MemoryLoadingStatus;
  allFactsError: string | null;
  allFactsPage: number;
  allFactsTotal: number;

  // Phase 9: Entries-first state
  entries: MemoryEntry[];
  entriesLoadingStatus: MemoryLoadingStatus;
  entriesError: string | null;
  currentPage: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  searchQuery: string;
  filters: MemoryListFilters;
  sortColumn: MemorySortColumn;
  sortDirection: MemorySortDirection;
  selectedIds: string[];
  expandedEntryId: string | null;
  entryFactsByEntryId: Record<string, MemoryEntryFact[]>;
  accessLogsByEntryId: Record<string, MemoryAccessLog[]>;
  relatedEntriesByEntryId: Record<string, MemoryEntry[]>;
  categories: MemoryCategory[];
  categoriesLoadingStatus: MemoryLoadingStatus;
  categoriesError: string | null;
  categoriesLastFetchedAt: number | null;
  stats: MemoryStatsSnapshot;
  statsLoadingStatus: MemoryLoadingStatus;
  statsError: string | null;
  statsLastFetchedAt: number | null;
  detailLoadingStatus: Record<string, MemoryLoadingStatus>;
  detailErrors: Record<string, string>;

  // --- Actions: Loading ---
  loadFactsByNodeId: (nodeId: string) => Promise<void>;
  loadFactsByDocumentId: (documentId: string) => Promise<void>;
  loadFactsByChatSessionId: (sessionId: string, since?: string) => Promise<void>;
  loadEvidence: (factId: string) => Promise<void>;
  loadAllFacts: (page?: number) => Promise<void>;
  loadMoreFacts: () => Promise<void>;

  // --- Actions: Mutations (Fact-level) ---
  reviewFact: (factId: string, action: ReviewAction, note?: string) => Promise<MemoryFact | null>;
  createFact: (payload: {
    subjectNodeId: string;
    predicate: string;
    objectNodeId?: string;
    objectText?: string;
    valueType?: FactValueType;
  }) => Promise<MemoryFact | null>;
  deleteFact: (factId: string) => Promise<boolean>;

  // --- Actions: Entries-first state (Phase 9) ---
  setCurrentPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setSearchQuery: (query: string) => void;
  setFilters: (patch: Partial<MemoryListFilters>) => void;
  clearFilters: () => void;
  setSort: (column: MemorySortColumn, direction: MemorySortDirection) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelectedId: (id: string) => void;
  clearSelectedIds: () => void;
  setExpandedEntryId: (entryId: string | null) => void;

  fetchEntries: (options?: {
    page?: number;
    pageSize?: number;
    append?: boolean;
    force?: boolean;
  }) => Promise<void>;
  fetchEntryFacts: (entryId: string, options?: { force?: boolean }) => Promise<void>;
  fetchStats: (options?: { force?: boolean }) => Promise<void>;
  fetchCategories: (options?: { force?: boolean }) => Promise<void>;
  fetchAccessLogs: (
    entryId: string,
    options?: { page?: number; pageSize?: number; force?: boolean }
  ) => Promise<void>;
  fetchRelatedEntries: (
    entryId: string,
    options?: { limit?: number; chatSessionId?: string; force?: boolean }
  ) => Promise<void>;
  createEntry: (payload: {
    content: string;
    metadata?: MemoryEntryCreateMetadata;
    facts?: MemoryEntryUpsertFactInput[];
    reextract?: boolean;
  }) => Promise<MemoryEntry | null>;
  updateEntry: (
    id: string,
    payload: {
      content: string;
      metadata?: MemoryEntryUpdateMetadata;
      facts?: MemoryEntryUpsertFactInput[];
      reextract?: boolean;
      replaceFacts?: boolean;
    }
  ) => Promise<MemoryEntry | null>;
  batchUpdateEntries: (
    ids: string[],
    action: MemoryBatchAction,
    options?: { note?: string; syncFacts?: boolean }
  ) => Promise<number>;
  deleteEntries: (ids: string[]) => Promise<number>;

  // --- Actions: State management ---
  clearNodeFacts: (nodeId: string) => void;
  clearDocumentFacts: (documentId: string) => void;
  reset: () => void;

  // --- Selectors ---
  /** 查找与给定 fact 冲突的其他 facts（同 subject+predicate，不同 object） */
  getConflictingFacts: (fact: MemoryFact) => MemoryFact[];
}

const STATS_CACHE_TTL_MS = 30_000;
const CATEGORIES_CACHE_TTL_MS = 300_000;

const initialFilters: MemoryListFilters = {
  sourceTypes: [],
  categories: [],
  states: [],
  reviewStatuses: [],
};

const initialStats: MemoryStatsSnapshot = {
  total: 0,
  byReviewStatus: {},
  bySourceType: {},
  byState: {},
};

const initialState = {
  factsByNodeId: {} as Record<string, MemoryFact[]>,
  factsByDocumentId: {} as Record<string, MemoryFact[]>,
  factsByChatSessionId: {} as Record<string, MemoryFact[]>,
  evidenceByFactId: {} as Record<string, MemoryEvidence[]>,
  loadingStatus: {} as Record<string, MemoryLoadingStatus>,
  errors: {} as Record<string, string>,
  allFacts: [] as MemoryFact[],
  allFactsLoadingStatus: "idle" as MemoryLoadingStatus,
  allFactsError: null as string | null,
  allFactsPage: 0,
  allFactsTotal: 0,

  entries: [] as MemoryEntry[],
  entriesLoadingStatus: "idle" as MemoryLoadingStatus,
  entriesError: null as string | null,
  currentPage: 1,
  pageSize: 20,
  totalCount: 0,
  totalPages: 1,
  searchQuery: "",
  filters: { ...initialFilters },
  sortColumn: "createdAt" as MemorySortColumn,
  sortDirection: "desc" as MemorySortDirection,
  selectedIds: [] as string[],
  expandedEntryId: null as string | null,
  entryFactsByEntryId: {} as Record<string, MemoryEntryFact[]>,
  accessLogsByEntryId: {} as Record<string, MemoryAccessLog[]>,
  relatedEntriesByEntryId: {} as Record<string, MemoryEntry[]>,
  categories: [] as MemoryCategory[],
  categoriesLoadingStatus: "idle" as MemoryLoadingStatus,
  categoriesError: null as string | null,
  categoriesLastFetchedAt: null as number | null,
  stats: { ...initialStats },
  statsLoadingStatus: "idle" as MemoryLoadingStatus,
  statsError: null as string | null,
  statsLastFetchedAt: null as number | null,
  detailLoadingStatus: {} as Record<string, MemoryLoadingStatus>,
  detailErrors: {} as Record<string, string>,
};

interface FactCollectionsState {
  factsByNodeId: Record<string, MemoryFact[]>;
  factsByDocumentId: Record<string, MemoryFact[]>;
  factsByChatSessionId: Record<string, MemoryFact[]>;
  allFacts: MemoryFact[];
}

/**
 * Helper: update a fact in all indexed maps (node, document, session).
 * Used after review/edit to keep local state in sync without refetching.
 */
function updateFactInMaps(
  state: FactCollectionsState,
  updatedFact: MemoryFact,
): Partial<FactCollectionsState> {
  const patch: Partial<FactCollectionsState> = {};

  // Update in factsByNodeId
  for (const [nodeId, facts] of Object.entries(state.factsByNodeId)) {
    const idx = facts.findIndex((f) => f.id === updatedFact.id);
    if (idx !== -1) {
      const next = [...facts];
      next[idx] = updatedFact;
      patch.factsByNodeId = { ...state.factsByNodeId, ...(patch.factsByNodeId ?? {}), [nodeId]: next };
    }
  }

  // Update in factsByDocumentId
  for (const [docId, facts] of Object.entries(state.factsByDocumentId)) {
    const idx = facts.findIndex((f) => f.id === updatedFact.id);
    if (idx !== -1) {
      const next = [...facts];
      next[idx] = updatedFact;
      patch.factsByDocumentId = { ...state.factsByDocumentId, ...(patch.factsByDocumentId ?? {}), [docId]: next };
    }
  }

  // Update in factsByChatSessionId
  for (const [sid, facts] of Object.entries(state.factsByChatSessionId)) {
    const idx = facts.findIndex((f) => f.id === updatedFact.id);
    if (idx !== -1) {
      const next = [...facts];
      next[idx] = updatedFact;
      patch.factsByChatSessionId = { ...state.factsByChatSessionId, ...(patch.factsByChatSessionId ?? {}), [sid]: next };
    }
  }

  // Update in allFacts
  const allIdx = state.allFacts.findIndex((f) => f.id === updatedFact.id);
  if (allIdx !== -1) {
    const nextAll = [...state.allFacts];
    nextAll[allIdx] = updatedFact;
    patch.allFacts = nextAll;
  }

  return patch;
}

/**
 * Helper: remove a fact from all indexed maps.
 */
function removeFactFromMaps(
  state: FactCollectionsState,
  factId: string,
): Partial<FactCollectionsState> {
  const patch: Partial<FactCollectionsState> = {};

  for (const [nodeId, facts] of Object.entries(state.factsByNodeId)) {
    if (facts.some((f) => f.id === factId)) {
      patch.factsByNodeId = {
        ...state.factsByNodeId,
        ...(patch.factsByNodeId ?? {}),
        [nodeId]: facts.filter((f) => f.id !== factId),
      };
    }
  }

  for (const [docId, facts] of Object.entries(state.factsByDocumentId)) {
    if (facts.some((f) => f.id === factId)) {
      patch.factsByDocumentId = {
        ...state.factsByDocumentId,
        ...(patch.factsByDocumentId ?? {}),
        [docId]: facts.filter((f) => f.id !== factId),
      };
    }
  }

  for (const [sid, facts] of Object.entries(state.factsByChatSessionId)) {
    if (facts.some((f) => f.id === factId)) {
      patch.factsByChatSessionId = {
        ...state.factsByChatSessionId,
        ...(patch.factsByChatSessionId ?? {}),
        [sid]: facts.filter((f) => f.id !== factId),
      };
    }
  }

  return patch;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function toEntrySearchFilters(filters: MemoryListFilters): MemoryEntrySearchFilters | undefined {
  const mapped: MemoryEntrySearchFilters = {};
  if (filters.sourceTypes.length > 0) {
    mapped.sourceTypes = filters.sourceTypes;
  }
  if (filters.categories.length > 0) {
    mapped.categories = filters.categories;
  }
  if (filters.states.length > 0) {
    mapped.states = filters.states;
  }
  if (filters.reviewStatuses.length > 0) {
    mapped.reviewStatus = filters.reviewStatuses;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function toApiSortColumn(
  column: MemorySortColumn
): "content" | "sourceType" | "createdAt" | "updatedAt" | "lastSeenAt" {
  return column;
}

function buildDetailKey(prefix: string, entryId: string): string {
  return `${prefix}:${entryId}`;
}

function hasOwnRecordKey<T>(record: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  ...initialState,

  // --- Loading actions ---

  loadFactsByNodeId: async (nodeId) => {
    const key = `node:${nodeId}`;
    set((s) => ({
      loadingStatus: { ...s.loadingStatus, [key]: "loading" },
    }));
    try {
      const facts = await apiClient.memory.getFactsByNodeId(nodeId);
      set((s) => ({
        factsByNodeId: { ...s.factsByNodeId, [nodeId]: facts },
        loadingStatus: { ...s.loadingStatus, [key]: "loaded" },
      }));
    } catch (error) {
      const msg = toErrorMessage(error, "Failed to load facts");
      set((s) => ({
        loadingStatus: { ...s.loadingStatus, [key]: "error" },
        errors: { ...s.errors, [key]: msg },
      }));
    }
  },

  loadFactsByDocumentId: async (documentId) => {
    const key = `doc:${documentId}`;
    set((s) => ({
      loadingStatus: { ...s.loadingStatus, [key]: "loading" },
    }));
    try {
      const result = await apiClient.memory.getFacts({
        documentId,
        pageSize: 100,
      });
      set((s) => ({
        factsByDocumentId: { ...s.factsByDocumentId, [documentId]: result.items },
        loadingStatus: { ...s.loadingStatus, [key]: "loaded" },
      }));
    } catch (error) {
      const msg = toErrorMessage(error, "Failed to load facts");
      set((s) => ({
        loadingStatus: { ...s.loadingStatus, [key]: "error" },
        errors: { ...s.errors, [key]: msg },
      }));
    }
  },

  loadFactsByChatSessionId: async (sessionId, since) => {
    const key = `chat:${sessionId}`;
    set((s) => ({
      loadingStatus: { ...s.loadingStatus, [key]: "loading" },
    }));
    try {
      const result = await apiClient.memory.getFacts({
        chatSessionId: sessionId,
        ...(since !== undefined ? { since } : {}),
        pageSize: 50,
      });
      set((s) => ({
        factsByChatSessionId: { ...s.factsByChatSessionId, [sessionId]: result.items },
        loadingStatus: { ...s.loadingStatus, [key]: "loaded" },
      }));
    } catch (error) {
      const msg = toErrorMessage(error, "Failed to load facts");
      set((s) => ({
        loadingStatus: { ...s.loadingStatus, [key]: "error" },
        errors: { ...s.errors, [key]: msg },
      }));
    }
  },

  loadEvidence: async (factId) => {
    try {
      const evidence = await apiClient.memory.getEvidence(factId);
      set((s) => ({
        evidenceByFactId: { ...s.evidenceByFactId, [factId]: evidence },
      }));
    } catch {
      // Best-effort — evidence loading failure is non-critical
    }
  },

  loadAllFacts: async (page?: number) => {
    const targetPage = page ?? 1;
    set({
      allFactsLoadingStatus: "loading" as MemoryLoadingStatus,
      allFactsError: null,
    });
    try {
      const result = await apiClient.memory.getFacts({ pageSize: 100, page: targetPage });
      set((s) => ({
        allFacts: targetPage === 1 ? result.items : [...s.allFacts, ...result.items],
        allFactsPage: result.page,
        allFactsTotal: result.totalCount,
        allFactsLoadingStatus: "loaded",
      }));
    } catch (error) {
      const msg = toErrorMessage(error, "Failed to load facts");
      set(() => ({
        allFactsLoadingStatus: "error" as MemoryLoadingStatus,
        allFactsError: msg,
      }));
    }
  },

  loadMoreFacts: async () => {
    const { allFactsPage, allFacts, allFactsTotal, allFactsLoadingStatus } = get();
    if (allFactsLoadingStatus === "loading") return;
    if (allFacts.length >= allFactsTotal) return;
    await get().loadAllFacts(allFactsPage + 1);
  },

  // --- Mutation actions (Fact-level) ---

  reviewFact: async (factId, action, note) => {
    try {
      const updated = await apiClient.memory.reviewFact(factId, action, note);
      set((s) => ({
        ...updateFactInMaps(s, updated),
        entries: s.entries.map((entry) => {
          if (entry.id !== updated.entryId) {
            return entry;
          }
          const nextEntry: MemoryEntry = {
            ...entry,
            reviewStatus: updated.reviewStatus,
            updatedAt: updated.updatedAt,
          };
          if (updated.reviewNote !== undefined) {
            if (updated.reviewNote.trim().length > 0) {
              nextEntry.reviewNote = updated.reviewNote;
            } else {
              delete nextEntry.reviewNote;
            }
          }
          return nextEntry;
        }),
      }));
      void get().fetchStats({ force: true });
      return updated;
    } catch {
      return null;
    }
  },

  createFact: async (payload) => {
    try {
      const created = await apiClient.memory.createFact(payload);
      // Append to the relevant node's facts list
      set((s) => {
        const nodeId = payload.subjectNodeId;
        const existing = s.factsByNodeId[nodeId] ?? [];
        return {
          factsByNodeId: {
            ...s.factsByNodeId,
            [nodeId]: [...existing, created],
          },
        };
      });
      return created;
    } catch {
      return null;
    }
  },

  deleteFact: async (factId) => {
    try {
      await apiClient.memory.deleteFact(factId);
      set((s) => ({
        ...removeFactFromMaps(s, factId),
      }));
      return true;
    } catch {
      return false;
    }
  },

  // --- Entries-first state (Phase 9) ---

  setCurrentPage: (page) => {
    const next = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
    set({ currentPage: next });
  },

  setPageSize: (size) => {
    const next = Number.isFinite(size) ? Math.max(1, Math.trunc(size)) : 10;
    set({ pageSize: next, currentPage: 1 });
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query.trim(), currentPage: 1 });
  },

  setFilters: (patch) => {
    set((s) => ({
      filters: {
        sourceTypes: patch.sourceTypes ?? s.filters.sourceTypes,
        categories: patch.categories ?? s.filters.categories,
        states: patch.states ?? s.filters.states,
        reviewStatuses: patch.reviewStatuses ?? s.filters.reviewStatuses,
      },
      currentPage: 1,
    }));
  },

  clearFilters: () => {
    set({ filters: { ...initialFilters }, currentPage: 1 });
  },

  setSort: (column, direction) => {
    set({ sortColumn: column, sortDirection: direction, currentPage: 1 });
  },

  setSelectedIds: (ids) => {
    set({ selectedIds: [...new Set(ids)] });
  },

  toggleSelectedId: (id) => {
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((item) => item !== id)
        : [...s.selectedIds, id],
    }));
  },

  clearSelectedIds: () => {
    set({ selectedIds: [] });
  },

  setExpandedEntryId: (entryId) => {
    set({ expandedEntryId: entryId });
  },

  fetchEntries: async (options) => {
    const state = get();
    const nextPage = options?.page ?? state.currentPage;
    const nextPageSize = options?.pageSize ?? state.pageSize;
    const apiSortBy = toApiSortColumn(state.sortColumn);

    set({
      currentPage: nextPage,
      pageSize: nextPageSize,
      entriesLoadingStatus: "loading",
      entriesError: null,
    });

    try {
      const query = state.searchQuery.length > 0 ? state.searchQuery : null;
      const filters = toEntrySearchFilters(state.filters);
      const result = await apiClient.memory.filterEntries({
        ...(query ? { query } : {}),
        ...(filters ? { filters } : {}),
        page: nextPage,
        pageSize: nextPageSize,
        sortBy: apiSortBy,
        sortOrder: state.sortDirection,
      });

      set((s) => {
        const totalPages = Math.max(1, Math.ceil(result.totalCount / Math.max(1, result.pageSize)));
        const nextEntries = options?.append ? [...s.entries, ...result.items] : result.items;
        const nextExpanded =
          s.expandedEntryId && nextEntries.some((entry) => entry.id === s.expandedEntryId)
            ? s.expandedEntryId
            : null;

        return {
          entries: nextEntries,
          totalCount: result.totalCount,
          totalPages,
          currentPage: result.page,
          pageSize: result.pageSize,
          entriesLoadingStatus: "loaded" as MemoryLoadingStatus,
          expandedEntryId: nextExpanded,
        };
      });
    } catch (error) {
      set({
        entriesLoadingStatus: "error",
        entriesError: toErrorMessage(error, "Failed to load memory entries"),
      });
    }
  },

  fetchEntryFacts: async (entryId, options) => {
    const key = buildDetailKey("entryFacts", entryId);
    const state = get();

    if (!options?.force && hasOwnRecordKey(state.entryFactsByEntryId, entryId)) {
      return;
    }
    if (state.detailLoadingStatus[key] === "loading") {
      return;
    }

    set((s) => ({
      detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "loading" },
      detailErrors: { ...s.detailErrors, [key]: "" },
    }));

    try {
      const facts = await apiClient.memory.getEntryFacts(entryId);
      set((s) => ({
        entryFactsByEntryId: { ...s.entryFactsByEntryId, [entryId]: facts },
        detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "loaded" },
      }));
    } catch (error) {
      set((s) => ({
        detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "error" },
        detailErrors: {
          ...s.detailErrors,
          [key]: toErrorMessage(error, "Failed to load memory entry facts"),
        },
      }));
    }
  },

  fetchStats: async (options) => {
    const state = get();
    const now = Date.now();

    if (
      !options?.force
      && state.statsLastFetchedAt !== null
      && now - state.statsLastFetchedAt < STATS_CACHE_TTL_MS
      && state.statsLoadingStatus === "loaded"
    ) {
      return;
    }

    if (state.statsLoadingStatus === "loading") {
      return;
    }

    set({ statsLoadingStatus: "loading", statsError: null });

    try {
      const result = await apiClient.memory.getStats();
      set({
        stats: {
          total: result.total,
          byReviewStatus: result.byReviewStatus,
          bySourceType: result.bySourceType,
          byState: result.byState,
        },
        statsLoadingStatus: "loaded",
        statsError: null,
        statsLastFetchedAt: Date.now(),
      });
    } catch (error) {
      set({
        statsLoadingStatus: "error",
        statsError: toErrorMessage(error, "Failed to load memory stats"),
      });
    }
  },

  fetchCategories: async (options) => {
    const state = get();
    const now = Date.now();

    if (
      !options?.force
      && state.categoriesLastFetchedAt !== null
      && now - state.categoriesLastFetchedAt < CATEGORIES_CACHE_TTL_MS
      && state.categoriesLoadingStatus === "loaded"
    ) {
      return;
    }

    if (state.categoriesLoadingStatus === "loading") {
      return;
    }

    set({ categoriesLoadingStatus: "loading", categoriesError: null });

    try {
      const categories = await apiClient.memory.getCategories();
      set({
        categories,
        categoriesLoadingStatus: "loaded",
        categoriesError: null,
        categoriesLastFetchedAt: Date.now(),
      });
    } catch (error) {
      set({
        categoriesLoadingStatus: "error",
        categoriesError: toErrorMessage(error, "Failed to load memory categories"),
      });
    }
  },

  fetchAccessLogs: async (entryId, options) => {
    const key = buildDetailKey("accessLogs", entryId);
    const state = get();

    if (!options?.force && hasOwnRecordKey(state.accessLogsByEntryId, entryId)) {
      return;
    }
    if (state.detailLoadingStatus[key] === "loading") {
      return;
    }

    set((s) => ({
      detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "loading" },
      detailErrors: { ...s.detailErrors, [key]: "" },
    }));

    try {
      const result = await apiClient.memory.getAccessLogs(entryId, {
        ...(options?.page !== undefined ? { page: options.page } : {}),
        ...(options?.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
      });
      set((s) => ({
        accessLogsByEntryId: { ...s.accessLogsByEntryId, [entryId]: result.items },
        detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "loaded" },
      }));
    } catch (error) {
      set((s) => ({
        detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "error" },
        detailErrors: {
          ...s.detailErrors,
          [key]: toErrorMessage(error, "Failed to load memory access logs"),
        },
      }));
    }
  },

  fetchRelatedEntries: async (entryId, options) => {
    const key = buildDetailKey("relatedEntries", entryId);
    const state = get();

    if (!options?.force && hasOwnRecordKey(state.relatedEntriesByEntryId, entryId)) {
      return;
    }
    if (state.detailLoadingStatus[key] === "loading") {
      return;
    }

    set((s) => ({
      detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "loading" },
      detailErrors: { ...s.detailErrors, [key]: "" },
    }));

    try {
      const relatedEntries = await apiClient.memory.getRelatedEntries(entryId, {
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.chatSessionId ? { chatSessionId: options.chatSessionId } : {}),
      });
      set((s) => ({
        relatedEntriesByEntryId: { ...s.relatedEntriesByEntryId, [entryId]: relatedEntries },
        detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "loaded" },
      }));
    } catch (error) {
      set((s) => ({
        detailLoadingStatus: { ...s.detailLoadingStatus, [key]: "error" },
        detailErrors: {
          ...s.detailErrors,
          [key]: toErrorMessage(error, "Failed to load related memory entries"),
        },
      }));
    }
  },

  createEntry: async (payload) => {
    try {
      const result = await apiClient.memory.createEntry(payload);
      set((s) => ({
        entryFactsByEntryId: { ...s.entryFactsByEntryId, [result.entry.id]: result.facts },
      }));
      await Promise.all([
        get().fetchEntries({ page: 1 }),
        get().fetchStats({ force: true }),
        get().fetchCategories({ force: true }),
      ]);
      return result.entry;
    } catch {
      return null;
    }
  },

  updateEntry: async (id, payload) => {
    try {
      const result = await apiClient.memory.updateEntry(id, payload);
      set((s) => ({
        entryFactsByEntryId: { ...s.entryFactsByEntryId, [id]: result.facts },
      }));
      await Promise.all([
        get().fetchEntries({ page: get().currentPage }),
        get().fetchStats({ force: true }),
        get().fetchCategories({ force: true }),
      ]);
      return result.entry;
    } catch {
      return null;
    }
  },

  batchUpdateEntries: async (ids, action, options) => {
    try {
      const result = await apiClient.memory.batchUpdateEntries(
        {
          ids,
          action,
          ...(options?.note ? { note: options.note } : {}),
          ...(options?.syncFacts !== undefined ? { sync_facts: options.syncFacts } : {}),
        },
      );

      const currentPage = get().currentPage;
      await Promise.all([
        get().fetchEntries({ page: currentPage }),
        get().fetchStats({ force: true }),
      ]);
      if (action === "delete" && get().entries.length === 0 && get().currentPage > 1) {
        await get().fetchEntries({ page: get().currentPage - 1 });
      }
      get().clearSelectedIds();
      return result.affected;
    } catch {
      return 0;
    }
  },

  deleteEntries: async (ids) => {
    try {
      const result = await apiClient.memory.deleteEntries(ids);
      const currentPage = get().currentPage;
      await Promise.all([
        get().fetchEntries({ page: currentPage }),
        get().fetchStats({ force: true }),
      ]);

      if (get().entries.length === 0 && get().currentPage > 1) {
        await get().fetchEntries({ page: get().currentPage - 1 });
      }

      get().clearSelectedIds();
      return result.affected;
    } catch {
      return 0;
    }
  },

  // --- State management ---

  clearNodeFacts: (nodeId) =>
    set((s) => {
      const { [nodeId]: _, ...rest } = s.factsByNodeId;
      const { [`node:${nodeId}`]: __, ...statusRest } = s.loadingStatus;
      return { factsByNodeId: rest, loadingStatus: statusRest };
    }),

  clearDocumentFacts: (documentId) =>
    set((s) => {
      const { [documentId]: _, ...rest } = s.factsByDocumentId;
      const { [`doc:${documentId}`]: __, ...statusRest } = s.loadingStatus;
      return { factsByDocumentId: rest, loadingStatus: statusRest };
    }),

  reset: () => set(initialState),

  // --- Selectors ---

  getConflictingFacts: (fact) => {
    const state = get();
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const predicate = normalize(fact.predicate);
    const allMaps = [state.factsByNodeId, state.factsByDocumentId, state.factsByChatSessionId];
    const seen = new Set<string>();
    const results: MemoryFact[] = [];

    for (const map of allMaps) {
      for (const facts of Object.values(map)) {
        for (const f of facts) {
          if (f.id === fact.id) continue;
          if (seen.has(f.id)) continue;
          if (f.subjectNodeId !== fact.subjectNodeId) continue;
          if (normalize(f.predicate) !== predicate) continue;
          // Different object = conflict
          const fObj = normalize(f.objectText ?? f.objectNodeId ?? "");
          const factObj = normalize(fact.objectText ?? fact.objectNodeId ?? "");
          if (fObj !== factObj) {
            seen.add(f.id);
            results.push(f);
          }
        }
      }
    }
    return results;
  },
}));
