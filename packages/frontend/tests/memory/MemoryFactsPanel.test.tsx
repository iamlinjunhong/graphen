import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryFact } from "@graphen/shared";
import { MemoryFactsPanel } from "../../src/memory/MemoryFactsPanel";

// Mock MemoryFactCard to simplify — we just need to verify it's rendered
vi.mock("../../src/memory/MemoryFactCard", () => ({
  MemoryFactCard: ({ fact, compact }: { fact: MemoryFact; compact: boolean }) => (
    <div data-testid={`fact-card-${fact.id}`} data-compact={compact}>
      {fact.predicate}
    </div>
  ),
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

afterEach(cleanup);

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "fact-1",
    subjectNodeId: "node-1",
    predicate: "likes",
    objectText: "coffee",
    valueType: "text",
    normalizedKey: "node-1|likes|coffee",
    confidence: 0.9,
    reviewStatus: "auto",
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("MemoryFactsPanel", () => {
  it('shows "提取完成 · 无新增记忆" when facts array is empty', () => {
    render(<MemoryFactsPanel facts={[]} hasConflicted={false} />);
    expect(screen.getByText("提取完成 · 无新增记忆")).toBeInTheDocument();
  });

  it("shows correct count when facts are present", () => {
    const facts = [makeFact({ id: "f1" }), makeFact({ id: "f2" })];
    render(<MemoryFactsPanel facts={facts} hasConflicted={false} />);
    expect(screen.getByText("提取完成 · 新增 2 条记忆")).toBeInTheDocument();
  });

  it("does not show expand toggle when facts are empty", () => {
    render(<MemoryFactsPanel facts={[]} hasConflicted={false} />);
    expect(screen.queryByText("展开")).not.toBeInTheDocument();
  });

  it("shows expand/collapse toggle and toggles fact cards", () => {
    const facts = [makeFact({ id: "f1" }), makeFact({ id: "f2" })];
    render(<MemoryFactsPanel facts={facts} hasConflicted={false} />);

    // Initially collapsed — toggle shows "展开"
    const toggle = screen.getByText("展开");
    expect(toggle).toBeInTheDocument();

    // Fact cards should not be visible yet
    expect(screen.queryByTestId("fact-card-f1")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(toggle);
    expect(screen.getByText("收起")).toBeInTheDocument();
    expect(screen.getByTestId("fact-card-f1")).toBeInTheDocument();
    expect(screen.getByTestId("fact-card-f2")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByText("收起"));
    expect(screen.getByText("展开")).toBeInTheDocument();
    expect(screen.queryByTestId("fact-card-f1")).not.toBeInTheDocument();
  });
});
