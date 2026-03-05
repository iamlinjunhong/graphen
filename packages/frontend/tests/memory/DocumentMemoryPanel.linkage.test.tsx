import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFact } from "@graphen/shared";

vi.mock("../../src/memory/MemoryFactCard", () => ({
  MemoryFactCard: ({ fact }: { fact: MemoryFact }) => (
    <div data-testid={`memory-fact-${fact.id}`}>{fact.predicate}</div>
  ),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

import { useMemoryStore } from "../../src/stores/useMemoryStore";
import { DocumentMemoryPanel } from "../../src/memory/DocumentMemoryPanel";

function makeFact(id: string): MemoryFact {
  return {
    id,
    subjectNodeId: "node-1",
    predicate: "负责",
    objectText: "技术团队",
    valueType: "text",
    normalizedKey: `node-1|负责|技术团队|${id}`,
    confidence: 0.9,
    reviewStatus: "auto",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  useMemoryStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useMemoryStore.getState().reset();
});

describe("DocumentMemoryPanel document linkage", () => {
  it("loads facts for the document and supports confirm-all", () => {
    const loadFactsByDocumentId = vi.fn().mockResolvedValue(undefined);
    const reviewFact = vi.fn().mockResolvedValue(null);

    useMemoryStore.setState({
      factsByDocumentId: { "doc-1": [makeFact("fact-1")] },
      loadingStatus: { "doc:doc-1": "loaded" },
      evidenceByFactId: {},
      loadFactsByDocumentId: loadFactsByDocumentId as any,
      reviewFact: reviewFact as any,
    });

    render(<DocumentMemoryPanel documentId="doc-1" documentStatus="completed" />);

    expect(loadFactsByDocumentId).toHaveBeenCalledWith("doc-1");
    expect(screen.getByText("文档记忆 (1 条事实)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部确认" }));
    expect(reviewFact).toHaveBeenCalledWith("fact-1", "confirm");
  });
});
