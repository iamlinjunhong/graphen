import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

const loadInitialGraphDataMock = vi.fn().mockResolvedValue(undefined);
const loadGraphDataMock = vi.fn().mockResolvedValue(undefined);
const expandNodeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/graph", search: "?focusNode=text%3A%E7%94%A8%E6%88%B7", hash: "", state: null }),
}));

vi.mock("../../src/services/api", () => ({
  apiClient: {
    documents: {
      list: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    },
  },
}));

vi.mock("../../src/hooks/useGraphData", () => ({
  useGraphData: () => ({
    graph: { nodes: [], edges: [] },
    reagraph: { nodes: [], edges: [] },
    isLoading: false,
    error: null,
    loadInitialGraphData: loadInitialGraphDataMock,
    loadGraphData: loadGraphDataMock,
    expandNode: expandNodeMock,
  }),
}));

vi.mock("../../src/graph/GraphCanvas", () => ({
  GraphCanvas: () => React.createElement("div", { "data-testid": "mock-graph-canvas" }),
}));

vi.mock("../../src/graph/GraphControls", () => ({
  GraphControls: () => React.createElement("div", { "data-testid": "mock-controls" }),
}));

vi.mock("../../src/graph/GraphSidebar", () => ({
  GraphSidebar: () => React.createElement("div", { "data-testid": "mock-sidebar" }),
}));

vi.mock("../../src/graph/NodeDetailPanel", () => ({
  NodeDetailPanel: () => React.createElement("div", { "data-testid": "mock-detail" }),
}));

vi.mock("../../src/graph/GraphQualityPanel", () => ({
  GraphQualityPanel: () => React.createElement("div", { "data-testid": "mock-quality" }),
}));

const { GraphView } = await import("../../src/graph/GraphView");
const { useGraphStore } = await import("../../src/stores/useGraphStore");

describe("GraphView focus-node bootstrap", () => {
  beforeEach(() => {
    loadInitialGraphDataMock.mockClear();
    loadGraphDataMock.mockClear();
    expandNodeMock.mockClear();
    useGraphStore.getState().reset();
  });

  afterEach(cleanup);

  it("loads centered subgraph when focusNode query param is provided", async () => {
    render(React.createElement(GraphView));

    await waitFor(() => {
      expect(loadGraphDataMock).toHaveBeenCalledWith({
        centerNodeIds: ["text:用户"],
        maxDepth: 2,
        maxNodes: 120,
      });
    });

    expect(loadInitialGraphDataMock).not.toHaveBeenCalled();
  });
});
