import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@graphen/shared";
import { MemoryTableRow } from "../../src/memory/MemoryTableRow";

afterEach(cleanup);

describe("MemoryTableRow status badge", () => {
  it("shows state badge for auto review entries", () => {
    renderRow(makeEntry({ reviewStatus: "auto", state: "active" }));

    const badge = screen.getByText("活跃");
    expect(badge).toHaveClass("memory-entry-state-badge", "is-active");
  });

  it("shows review-status badge for rejected entries", () => {
    renderRow(makeEntry({ reviewStatus: "rejected", state: "active" }));

    const badge = screen.getByText("已拒绝");
    expect(badge).toHaveClass("memory-status-badge", "is-rejected");
  });
});

function renderRow(entry: MemoryEntry): void {
  render(
    <table>
      <tbody>
        <MemoryTableRow
          entry={entry}
          selected={false}
          expanded={false}
          entryFacts={[]}
          factsLoadingStatus="idle"
          factsError={null}
          evidenceByFactId={{}}
          accessLogs={[]}
          accessLogsLoadingStatus="idle"
          accessLogsError={null}
          relatedEntries={[]}
          relatedEntriesLoadingStatus="idle"
          relatedEntriesError={null}
          onToggleSelected={vi.fn()}
          onToggleExpanded={vi.fn()}
          onNavigateToEntry={vi.fn()}
          onAction={vi.fn()}
        />
      </tbody>
    </table>
  );
}

function makeEntry(
  patch: Partial<Pick<MemoryEntry, "state" | "reviewStatus">> = {}
): MemoryEntry {
  return {
    id: "entry-1",
    content: "测试记忆内容",
    normalizedContentKey: "entry-1",
    state: patch.state ?? "active",
    reviewStatus: patch.reviewStatus ?? "auto",
    categories: [],
    sourceType: "manual",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
