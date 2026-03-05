import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "@graphen/shared";
import { NodeDetailPanel } from "../../src/graph/NodeDetailPanel";

vi.mock("../../src/memory/NodeMemorySection", () => ({
  NodeMemorySection: ({ nodeId, nodeName }: { nodeId: string; nodeName: string }) => (
    <div data-testid="node-memory-section">
      {nodeId}:{nodeName}
    </div>
  ),
}));

function makeNode(): GraphNode {
  return {
    id: "node-1",
    name: "张三",
    type: "person",
    description: "测试节点",
    properties: {},
    sourceDocumentIds: ["doc-1"],
    sourceChunkIds: [],
    confidence: 0.92,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

afterEach(cleanup);

describe("NodeDetailPanel memory linkage", () => {
  it("renders NodeMemorySection with current node context", () => {
    render(
      <NodeDetailPanel
        node={makeNode()}
        degree={3}
        neighborNames={["李四", "王五"]}
        isExpanding={false}
        documentLabels={new Map([["doc-1", "文档A"]])}
        inferredRelations={[]}
        onExpand={vi.fn()}
        onClose={vi.fn()}
        onFilterDocument={vi.fn()}
      />
    );

    expect(screen.getByTestId("node-memory-section")).toHaveTextContent("node-1:张三");
  });
});
