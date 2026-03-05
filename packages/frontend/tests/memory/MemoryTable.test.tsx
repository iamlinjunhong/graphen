import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@graphen/shared";
import { MemoryTable } from "../../src/memory/MemoryTable";

vi.mock("../../src/memory/MemoryTableRow", () => ({
  MemoryTableRow: ({
    entry,
    selected,
    onToggleSelected,
    onToggleExpanded,
  }: {
    entry: MemoryEntry;
    selected: boolean;
    onToggleSelected: (entryId: string, checked: boolean) => void;
    onToggleExpanded: (entryId: string) => void;
  }) => (
    <tr data-testid={`memory-row-${entry.id}`} onClick={() => onToggleExpanded(entry.id)}>
      <td>
        <input
          type="checkbox"
          aria-label={`row-select-${entry.id}`}
          checked={selected}
          onChange={(event) => onToggleSelected(entry.id, event.currentTarget.checked)}
        />
      </td>
      <td>{entry.content}</td>
    </tr>
  ),
}));

function makeEntry(id: string, content = `记忆-${id}`): MemoryEntry {
  return {
    id,
    content,
    normalizedContentKey: `key-${id}`,
    state: "active",
    reviewStatus: "auto",
    categories: [],
    sourceType: "manual",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("MemoryTable", () => {
  it("renders empty state when there are no entries", () => {
    render(
      <MemoryTable
        entries={[]}
        selectedIds={new Set()}
        allVisibleSelected={false}
        someVisibleSelected={false}
        expandedEntryId={null}
        entryFactsByEntryId={{}}
        accessLogsByEntryId={{}}
        relatedEntriesByEntryId={{}}
        detailLoadingStatus={{}}
        detailErrors={{}}
        evidenceByFactId={{}}
        onToggleSelectAll={vi.fn()}
        onToggleSelected={vi.fn()}
        onToggleExpanded={vi.fn()}
        onNavigateToEntry={vi.fn()}
        onRowAction={vi.fn()}
      />
    );

    expect(screen.getByText("暂无记忆数据")).toBeInTheDocument();
  });

  it("calls onToggleSelectAll when header checkbox is clicked", () => {
    const onToggleSelectAll = vi.fn();

    render(
      <MemoryTable
        entries={[makeEntry("entry-1")]}
        selectedIds={new Set()}
        allVisibleSelected={false}
        someVisibleSelected={false}
        expandedEntryId={null}
        entryFactsByEntryId={{}}
        accessLogsByEntryId={{}}
        relatedEntriesByEntryId={{}}
        detailLoadingStatus={{}}
        detailErrors={{}}
        evidenceByFactId={{}}
        onToggleSelectAll={onToggleSelectAll}
        onToggleSelected={vi.fn()}
        onToggleExpanded={vi.fn()}
        onNavigateToEntry={vi.fn()}
        onRowAction={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前页" }));
    expect(onToggleSelectAll).toHaveBeenCalledWith(true);
  });

  it("sets header checkbox indeterminate when some visible rows are selected", async () => {
    render(
      <MemoryTable
        entries={[makeEntry("entry-1"), makeEntry("entry-2")]}
        selectedIds={new Set(["entry-1"])}
        allVisibleSelected={false}
        someVisibleSelected
        expandedEntryId={null}
        entryFactsByEntryId={{}}
        accessLogsByEntryId={{}}
        relatedEntriesByEntryId={{}}
        detailLoadingStatus={{}}
        detailErrors={{}}
        evidenceByFactId={{}}
        onToggleSelectAll={vi.fn()}
        onToggleSelected={vi.fn()}
        onToggleExpanded={vi.fn()}
        onNavigateToEntry={vi.fn()}
        onRowAction={vi.fn()}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "全选当前页" }) as HTMLInputElement;
    await waitFor(() => {
      expect(checkbox.indeterminate).toBe(true);
    });
  });
});
