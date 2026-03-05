import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry, MemoryEntryFact } from "@graphen/shared";
import { MemoryRouter } from "react-router-dom";

const { memoryApi } = vi.hoisted(() => ({
  memoryApi: {
    filterEntries: vi.fn(),
    getStats: vi.fn(),
    getCategories: vi.fn(),
    getEntryFacts: vi.fn(),
    getAccessLogs: vi.fn(),
    getRelatedEntries: vi.fn(),
    getEvidence: vi.fn(),
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
    batchUpdateEntries: vi.fn(),
  },
}));

vi.mock("../../src/services/api", () => ({
  apiClient: {
    memory: memoryApi,
  },
}));

import { useMemoryStore } from "../../src/stores/useMemoryStore";
import { MemoryWeavingPage } from "../../src/memory/MemoryWeavingPage";

function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    content: `记忆内容-${id}`,
    normalizedContentKey: `key-${id}`,
    state: "active",
    reviewStatus: "auto",
    categories: ["工作"],
    sourceType: "manual",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntryFact(id: string, entryId: string): MemoryEntryFact {
  return {
    id,
    entryId,
    subjectText: "张三",
    predicate: "负责",
    objectText: "技术团队",
    valueType: "text",
    normalizedFactKey: `fact|${id}`,
    confidence: 0.91,
    factState: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    neo4jSynced: false,
    neo4jRetryCount: 0,
  };
}

function renderMemoryWeavingPage() {
  return render(
    <MemoryRouter>
      <MemoryWeavingPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useMemoryStore.getState().reset();

  memoryApi.filterEntries.mockImplementation(async (payload: { page?: number; pageSize?: number }) => {
    const page = payload.page ?? 1;
    const pageSize = payload.pageSize ?? 10;
    const items = page === 1
      ? [makeEntry("entry-1", { content: "第一页记忆" })]
      : [makeEntry("entry-2", { content: "第二页记忆" })];

    return {
      items,
      totalCount: 20,
      page,
      pageSize,
    };
  });

  memoryApi.getStats.mockResolvedValue({
    total: 20,
    byReviewStatus: { auto: 8, confirmed: 10, conflicted: 2 },
    bySourceType: { document: 6, chat_user: 4, chat_assistant: 4, manual: 6 },
    byState: { active: 20 },
  });

  memoryApi.getCategories.mockResolvedValue([
    { name: "工作", description: null, count: 12 },
    { name: "生活", description: null, count: 8 },
  ]);

  memoryApi.getEntryFacts.mockResolvedValue([makeEntryFact("fact-1", "entry-1")]);
  memoryApi.getAccessLogs.mockResolvedValue({
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
  });
  memoryApi.getRelatedEntries.mockResolvedValue([]);
  memoryApi.getEvidence.mockResolvedValue([]);

  memoryApi.createEntry.mockResolvedValue({
    entry: makeEntry("entry-new", { content: "新增记忆" }),
    facts: [],
  });

  memoryApi.updateEntry.mockResolvedValue({
    entry: makeEntry("entry-1", { content: "编辑后的记忆" }),
    facts: [makeEntryFact("fact-1", "entry-1")],
  });

  memoryApi.batchUpdateEntries.mockResolvedValue({
    action: "pause",
    affected: 1,
    sync_facts: false,
  });
});

afterEach(() => {
  cleanup();
  useMemoryStore.getState().reset();
  vi.useRealTimers();
});

describe("MemoryWeavingPage e2e flows", () => {
  it("uses backend sorting for content/sourceType and does not re-sort in page", async () => {
    memoryApi.filterEntries.mockImplementation(
      async (payload: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string }) => {
        const page = payload.page ?? 1;
        const pageSize = payload.pageSize ?? 10;

        if (payload.sortBy === "content" && payload.sortOrder === "asc") {
          return {
            items: [
              makeEntry("entry-z", { content: "Z内容", sourceType: "manual" }),
              makeEntry("entry-a", { content: "A内容", sourceType: "document" }),
            ],
            totalCount: 2,
            page,
            pageSize,
          };
        }

        if (payload.sortBy === "sourceType" && payload.sortOrder === "asc") {
          return {
            items: [
              makeEntry("entry-manual", { content: "手动来源", sourceType: "manual" }),
              makeEntry("entry-doc", { content: "文档来源", sourceType: "document" }),
            ],
            totalCount: 2,
            page,
            pageSize,
          };
        }

        return {
          items: [makeEntry("entry-1", { content: "默认记忆" })],
          totalCount: 1,
          page,
          pageSize,
        };
      }
    );

    renderMemoryWeavingPage();
    expect(await screen.findByText("默认记忆")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /排序:/ }));
    fireEvent.click(screen.getByRole("button", { name: "内容" }));
    fireEvent.click(screen.getByRole("button", { name: "升序" }));

    await waitFor(() => {
      expect(memoryApi.filterEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: "content",
          sortOrder: "asc",
        })
      );
    });
    expect(await screen.findByText("Z内容")).toBeInTheDocument();
    expect(await screen.findByText("A内容")).toBeInTheDocument();
    const contentSortedIds = Array.from(
      document.querySelectorAll("tr[data-memory-entry-id]")
    ).map((row) => row.getAttribute("data-memory-entry-id"));
    expect(contentSortedIds).toEqual(["entry-z", "entry-a"]);

    fireEvent.click(screen.getByRole("button", { name: "来源" }));
    fireEvent.click(screen.getByRole("button", { name: "升序" }));

    await waitFor(() => {
      expect(memoryApi.filterEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: "sourceType",
          sortOrder: "asc",
        })
      );
    });
    expect(await screen.findByText("手动来源")).toBeInTheDocument();
    expect(await screen.findByText("文档来源")).toBeInTheDocument();
    const sourceSortedIds = Array.from(
      document.querySelectorAll("tr[data-memory-entry-id]")
    ).map((row) => row.getAttribute("data-memory-entry-id"));
    expect(sourceSortedIds).toEqual(["entry-manual", "entry-doc"]);
  });

  it("loads list and supports pagination", async () => {
    renderMemoryWeavingPage();

    expect(await screen.findByText("第一页记忆")).toBeInTheDocument();
    expect(memoryApi.filterEntries).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 10 }));

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    await waitFor(() => {
      expect(memoryApi.filterEntries).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 10 }));
    });
    expect(await screen.findByText("第二页记忆")).toBeInTheDocument();
  });

  it("supports search and filter", async () => {
    renderMemoryWeavingPage();

    expect(await screen.findByText("第一页记忆")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索记忆" }), {
      target: { value: "  项目A  " },
    });

    await waitFor(() => {
      expect(memoryApi.filterEntries).toHaveBeenCalledWith(expect.objectContaining({ query: "项目A" }));
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole("button", { name: /筛选/ }));
    fireEvent.click(screen.getByRole("tab", { name: "分类" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /工作/ }));
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));

    await waitFor(() => {
      expect(memoryApi.filterEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            categories: ["工作"],
          }),
        })
      );
    });
  });

  it("supports creating and editing entries", async () => {
    renderMemoryWeavingPage();
    expect(await screen.findByText("第一页记忆")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /新建记忆/ }));
    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "  新增测试记忆  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));

    await waitFor(() => {
      expect(memoryApi.createEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "新增测试记忆",
          reextract: true,
        })
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "行操作" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("记忆内容"), {
      target: { value: "  编辑后内容  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => {
      expect(memoryApi.updateEntry).toHaveBeenCalledWith(
        "entry-1",
        expect.objectContaining({
          content: "编辑后内容",
          reextract: true,
          replaceFacts: true,
        })
      );
    });
  });

  it("supports batch action", async () => {
    renderMemoryWeavingPage();
    expect(await screen.findByText("第一页记忆")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择记忆 entry-1" }));
    fireEvent.click(screen.getByRole("button", { name: "批量操作 (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "批量暂停" }));

    await waitFor(() => {
      expect(memoryApi.batchUpdateEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ["entry-1"],
          action: "pause",
        })
      );
    });
  });

  it("loads detail data when expanding a row", async () => {
    renderMemoryWeavingPage();
    expect(await screen.findByText("第一页记忆")).toBeInTheDocument();

    fireEvent.click(screen.getByText("第一页记忆"));

    await waitFor(() => {
      expect(memoryApi.getEntryFacts).toHaveBeenCalledWith("entry-1");
    });
    await waitFor(() => {
      expect(memoryApi.getAccessLogs).toHaveBeenCalledWith("entry-1", expect.any(Object));
    });
    await waitFor(() => {
      expect(memoryApi.getRelatedEntries).toHaveBeenCalledWith("entry-1", expect.any(Object));
    });
    expect(await screen.findByText("记忆详情")).toBeInTheDocument();
  });
});
