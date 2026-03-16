import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { MemoryEntry, MemoryEntryFact } from "@graphen/shared";
import { MemoryDetailPanel } from "../../src/memory/MemoryDetailPanel";

function makeEntry(id: string): MemoryEntry {
  return {
    id,
    content: "测试记忆内容",
    normalizedContentKey: `key-${id}`,
    state: "active",
    reviewStatus: "auto",
    categories: ["工作"],
    sourceType: "manual",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeFact(id: string, entryId: string): MemoryEntryFact {
  return {
    id,
    entryId,
    subjectNodeId: "node-graph-1",
    subjectText: "张三",
    predicate: "任职",
    objectText: "CTO",
    valueType: "text",
    normalizedFactKey: `fact|${id}`,
    confidence: 0.95,
    factState: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    neo4jSynced: false,
    neo4jRetryCount: 0,
  };
}

afterEach(cleanup);

describe("MemoryDetailPanel graph linkage", () => {
  it("builds graph link with focusNode from fact subjectNodeId", () => {
    render(
      <MemoryRouter>
        <MemoryDetailPanel
          entry={makeEntry("entry-1")}
          facts={[makeFact("fact-1", "entry-1")]}
          factsLoadingStatus="loaded"
          factsError={null}
          evidenceByFactId={{}}
          accessLogs={[]}
          accessLogsLoadingStatus="loaded"
          accessLogsError={null}
          relatedEntries={[]}
          relatedEntriesLoadingStatus="loaded"
          relatedEntriesError={null}
          onNavigateToEntry={vi.fn()}
          onAction={vi.fn()}
        />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "在图谱中查看" });
    expect(link).toHaveAttribute("href", "/graph?focusNode=node-graph-1");
  });

  it("prefers object focus for name-like predicates with text object values", () => {
    const fact: MemoryEntryFact = {
      id: "fact-2",
      entryId: "entry-2",
      subjectText: "用户",
      predicate: "姓名",
      objectText: "小红",
      valueType: "text",
      normalizedFactKey: "用户|姓名|小红",
      confidence: 0.88,
      factState: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      neo4jSynced: false,
      neo4jRetryCount: 0,
    };

    render(
      <MemoryRouter>
        <MemoryDetailPanel
          entry={makeEntry("entry-2")}
          facts={[fact]}
          factsLoadingStatus="loaded"
          factsError={null}
          evidenceByFactId={{}}
          accessLogs={[]}
          accessLogsLoadingStatus="loaded"
          accessLogsError={null}
          relatedEntries={[]}
          relatedEntriesLoadingStatus="loaded"
          relatedEntriesError={null}
          onNavigateToEntry={vi.fn()}
          onAction={vi.fn()}
        />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "在图谱中查看" });
    expect(link).toHaveAttribute(
      "href",
      "/graph?focusNode=value%3Aentry-2%3A%E7%94%A8%E6%88%B7%7C%E5%A7%93%E5%90%8D%7C%E5%B0%8F%E7%BA%A2"
    );
  });
});
