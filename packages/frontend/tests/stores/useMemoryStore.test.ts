import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry, MemoryFact } from "@graphen/shared";
import { apiClient } from "../../src/services/api";
import { useMemoryStore } from "../../src/stores/useMemoryStore";

function makeFact(id: string): MemoryFact {
  return {
    id,
    subjectNodeId: "node-1",
    predicate: "likes",
    objectText: "coffee",
    valueType: "text",
    normalizedKey: `node-1|likes|coffee-${id}`,
    confidence: 0.9,
    reviewStatus: "auto",
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeEntry(id: string): MemoryEntry {
  return {
    id,
    content: "测试记忆",
    normalizedContentKey: `entry-${id}`,
    state: "active",
    reviewStatus: "auto",
    categories: [],
    sourceType: "manual",
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  useMemoryStore.getState().reset();
});

afterEach(() => {
  useMemoryStore.getState().reset();
  vi.restoreAllMocks();
});

describe("useMemoryStore.loadMoreFacts", () => {
  it("does not trigger a second page request while loading", async () => {
    const loadAllFacts = vi.fn().mockResolvedValue(undefined);

    useMemoryStore.setState({
      allFacts: [makeFact("fact-1")],
      allFactsPage: 1,
      allFactsTotal: 5,
      allFactsLoadingStatus: "loading",
      loadAllFacts: loadAllFacts as any,
    });

    await useMemoryStore.getState().loadMoreFacts();
    expect(loadAllFacts).not.toHaveBeenCalled();
  });

  it("requests the next page when more facts are available", async () => {
    const loadAllFacts = vi.fn().mockResolvedValue(undefined);

    useMemoryStore.setState({
      allFacts: [makeFact("fact-1")],
      allFactsPage: 1,
      allFactsTotal: 5,
      allFactsLoadingStatus: "loaded",
      loadAllFacts: loadAllFacts as any,
    });

    await useMemoryStore.getState().loadMoreFacts();
    expect(loadAllFacts).toHaveBeenCalledWith(2);
  });

  it("does not request more pages when all facts are loaded", async () => {
    const loadAllFacts = vi.fn().mockResolvedValue(undefined);

    useMemoryStore.setState({
      allFacts: [makeFact("fact-1"), makeFact("fact-2")],
      allFactsPage: 1,
      allFactsTotal: 2,
      allFactsLoadingStatus: "loaded",
      loadAllFacts: loadAllFacts as any,
    });

    await useMemoryStore.getState().loadMoreFacts();
    expect(loadAllFacts).not.toHaveBeenCalled();
  });
});

describe("useMemoryStore.reviewFact", () => {
  it("syncs entry reviewStatus after rejecting a fact", async () => {
    const reviewed = {
      ...makeFact("fact-1"),
      entryId: "entry-1",
      reviewStatus: "rejected" as const,
      reviewNote: "低质量身份表达",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    const reviewSpy = vi.spyOn(apiClient.memory, "reviewFact").mockResolvedValue(reviewed);
    const fetchStats = vi.fn().mockResolvedValue(undefined);

    useMemoryStore.setState({
      factsByNodeId: {
        "node-1": [{ ...makeFact("fact-1"), entryId: "entry-1" }],
      },
      entries: [makeEntry("entry-1")],
      fetchStats: fetchStats as any,
    });

    const result = await useMemoryStore.getState().reviewFact("fact-1", "reject");
    expect(result?.reviewStatus).toBe("rejected");

    const state = useMemoryStore.getState();
    expect(state.entries[0]?.reviewStatus).toBe("rejected");
    expect(state.entries[0]?.reviewNote).toBe("低质量身份表达");
    expect(state.entries[0]?.updatedAt).toBe("2026-01-02T00:00:00Z");
    expect(state.factsByNodeId["node-1"]?.[0]?.reviewStatus).toBe("rejected");
    expect(reviewSpy).toHaveBeenCalledWith("fact-1", "reject", undefined);
    expect(fetchStats).toHaveBeenCalledWith({ force: true });
  });
});
