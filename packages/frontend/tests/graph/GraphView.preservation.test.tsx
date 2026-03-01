/**
 * Preservation Property Test - Property 2: Non-first-mount scenarios behavior unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 *
 * These tests observe and capture the baseline behavior of the UNFIXED code
 * for non-bug scenarios. They should PASS on the current unfixed code and
 * continue to PASS after the fix is applied (preservation guarantee).
 *
 * Observation-first methodology:
 * - Layout mode switching → fitNodesInView is called
 * - Empty nodes (length=0) → fitNodesInView is NOT called
 * - handleResetView → resetControls(true) and fitNodesInView() are called
 * - Search filtering changes node subset → effect re-triggers fitNodesInView
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent, screen } from "@testing-library/react";
import * as fc from "fast-check";
import React from "react";
import type { GraphLayoutMode } from "../../src/stores/useGraphStore";

// --- Types for mocking ---
interface MockGraphCanvasRef {
  fitNodesInView: ReturnType<typeof vi.fn>;
  resetControls: ReturnType<typeof vi.fn>;
  zoomIn: ReturnType<typeof vi.fn>;
  zoomOut: ReturnType<typeof vi.fn>;
}

interface ReagraphNode {
  id: string;
  label: string;
  fill: string;
  size: number;
  data: Record<string, unknown>;
}

interface ReagraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  size: number;
  data: Record<string, unknown>;
}

// --- Shared mock state ---
let mockGraphRef: MockGraphCanvasRef;
let mockReagraphNodes: ReagraphNode[] = [];
let mockReagraphEdges: ReagraphEdge[] = [];
let mockLayoutMode: GraphLayoutMode = "force";
let mockSetLayoutMode: (mode: GraphLayoutMode) => void = () => {};
let mockResetViewHandler: (() => void) | null = null;

// --- Helper: generate mock nodes ---
function generateNodes(count: number): ReagraphNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    label: `Node ${i}\n[Type]`,
    fill: "#3566b8",
    size: 16,
    data: {
      id: `node-${i}`,
      name: `Node ${i}`,
      type: "Concept",
      description: `Description for node ${i}`,
      sourceDocumentIds: [],
      confidence: 0.9,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }));
}

function generateEdges(nodeCount: number): ReagraphEdge[] {
  if (nodeCount < 2) return [];
  const edgeCount = Math.min(nodeCount - 1, Math.floor(nodeCount * 0.8));
  return Array.from({ length: edgeCount }, (_, i) => ({
    id: `edge-${i}`,
    source: `node-${i}`,
    target: `node-${(i + 1) % nodeCount}`,
    label: "relates_to",
    size: 2,
    data: {
      id: `edge-${i}`,
      sourceNodeId: `node-${i}`,
      targetNodeId: `node-${(i + 1) % nodeCount}`,
      relationType: "relates_to",
      weight: 0.8,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }));
}

// --- Mock modules ---

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/graph", search: "", hash: "", state: null }),
}));

vi.mock("../../src/services/api", () => ({
  apiClient: {
    documents: {
      list: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    },
    graph: {
      getSubgraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getNeighbors: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    },
  },
}));

vi.mock("../../src/hooks/useGraphData", () => ({
  useGraphData: () => ({
    graph: { nodes: [], edges: [] },
    reagraph: { nodes: mockReagraphNodes, edges: mockReagraphEdges },
    isLoading: false,
    error: null,
    loadInitialGraphData: vi.fn().mockResolvedValue(undefined),
    expandNode: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Mock GraphCanvas to capture graphRef
vi.mock("../../src/graph/GraphCanvas", () => ({
  GraphCanvas: (props: { graphRef: React.RefObject<MockGraphCanvasRef | null> }) => {
    React.useEffect(() => {
      if (props.graphRef && "current" in props.graphRef) {
        (props.graphRef as React.MutableRefObject<MockGraphCanvasRef | null>).current = mockGraphRef;
      }
      return () => {
        if (props.graphRef && "current" in props.graphRef) {
          (props.graphRef as React.MutableRefObject<MockGraphCanvasRef | null>).current = null;
        }
      };
    }, [props.graphRef]);
    return React.createElement("div", { "data-testid": "mock-graph-canvas" });
  },
}));

// Mock GraphControls to capture onResetView and onLayoutChange
vi.mock("../../src/graph/GraphControls", () => ({
  GraphControls: (props: {
    layoutMode: string;
    onLayoutChange: (mode: GraphLayoutMode) => void;
    onResetView: () => void;
  }) => {
    // Store the handlers so tests can invoke them
    mockSetLayoutMode = props.onLayoutChange;
    mockResetViewHandler = props.onResetView;
    return React.createElement("div", { "data-testid": "mock-controls" },
      React.createElement("button", {
        "data-testid": "reset-view-btn",
        onClick: props.onResetView,
      }, "Fit"),
    );
  },
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

describe("Preservation Property: Non-first-mount scenario behaviors unchanged", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockResetViewHandler = null;

    mockGraphRef = {
      fitNodesInView: vi.fn(),
      resetControls: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
    };

    mockReagraphNodes = [];
    mockReagraphEdges = [];

    // Reset the store to default state
    useGraphStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Property 2a: Layout mode switching → fitNodesInView is called
   *
   * **Validates: Requirements 3.1**
   *
   * Observation: When layoutMode changes and nodes are present,
   * the fitNodesInView effect re-triggers and calls fitNodesInView.
   * This behavior must be preserved after the fix.
   */
  it("should call fitNodesInView after layout mode switching when nodes are present", () => {
    const layoutModes: GraphLayoutMode[] = ["force", "radial", "tree", "force-3d"];

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.constantFrom(...layoutModes),
        fc.constantFrom(...layoutModes),
        (nodeCount, initialMode, targetMode) => {
          // Skip if same mode (no change to trigger effect)
          if (initialMode === targetMode) return;

          cleanup();

          // Set up nodes
          mockReagraphNodes = generateNodes(nodeCount);
          mockReagraphEdges = generateEdges(nodeCount);

          mockGraphRef = {
            fitNodesInView: vi.fn(),
            resetControls: vi.fn(),
            zoomIn: vi.fn(),
            zoomOut: vi.fn(),
          };

          // Set initial layout mode in store
          useGraphStore.getState().setLayoutMode(initialMode);

          // Mount the component
          act(() => {
            render(React.createElement(GraphView));
          });

          // Advance timers to let initial fitNodesInView calls complete
          act(() => {
            vi.advanceTimersByTime(4000);
          });

          // Record call count after initial mount
          const callsAfterMount = mockGraphRef.fitNodesInView.mock.calls.length;

          // Now switch layout mode via the store
          act(() => {
            useGraphStore.getState().setLayoutMode(targetMode);
          });

          // Advance timers to let the effect fire
          act(() => {
            vi.advanceTimersByTime(4000);
          });

          const callsAfterSwitch = mockGraphRef.fitNodesInView.mock.calls.length;

          // fitNodesInView should have been called additional times after layout switch
          expect(
            callsAfterSwitch,
            `fitNodesInView should be called after switching from ${initialMode} to ${targetMode} ` +
            `with ${nodeCount} nodes. Calls after mount: ${callsAfterMount}, after switch: ${callsAfterSwitch}`
          ).toBeGreaterThan(callsAfterMount);
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 2b: Empty nodes → fitNodesInView is NOT called
   *
   * **Validates: Requirements 3.5**
   *
   * Observation: When visibleReagraph.nodes.length is 0,
   * the fitNodesInView effect returns early and does NOT call fitNodesInView.
   */
  it("should NOT call fitNodesInView when nodes array is empty", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<GraphLayoutMode>("force", "radial", "tree", "force-3d"),
        (layoutMode) => {
          cleanup();

          // Set up EMPTY nodes
          mockReagraphNodes = [];
          mockReagraphEdges = [];

          mockGraphRef = {
            fitNodesInView: vi.fn(),
            resetControls: vi.fn(),
            zoomIn: vi.fn(),
            zoomOut: vi.fn(),
          };

          useGraphStore.getState().setLayoutMode(layoutMode);

          // Mount the component with empty data
          act(() => {
            render(React.createElement(GraphView));
          });

          // Advance timers well past all possible delays
          act(() => {
            vi.advanceTimersByTime(5000);
          });

          // fitNodesInView should NOT have been called
          expect(
            mockGraphRef.fitNodesInView.mock.calls.length,
            `fitNodesInView should not be called with 0 nodes in ${layoutMode} mode`
          ).toBe(0);
        }
      ),
      { numRuns: 10 }
    );
  });

  /**
   * Property 2c: handleResetView calls resetControls(true) and fitNodesInView()
   *
   * **Validates: Requirements 3.4**
   *
   * Observation: When the user clicks "Fit" (Reset View), the handler
   * calls graphRef.current.resetControls(true) and graphRef.current.fitNodesInView().
   */
  it("should call resetControls(true) and fitNodesInView() on handleResetView", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (nodeCount) => {
          cleanup();

          mockReagraphNodes = generateNodes(nodeCount);
          mockReagraphEdges = generateEdges(nodeCount);

          mockGraphRef = {
            fitNodesInView: vi.fn(),
            resetControls: vi.fn(),
            zoomIn: vi.fn(),
            zoomOut: vi.fn(),
          };

          // Mount the component
          act(() => {
            render(React.createElement(GraphView));
          });

          // Advance timers to let initial effects settle
          act(() => {
            vi.advanceTimersByTime(4000);
          });

          // Clear mocks to isolate the reset view behavior
          mockGraphRef.fitNodesInView.mockClear();
          mockGraphRef.resetControls.mockClear();

          // Trigger handleResetView via the captured handler
          expect(mockResetViewHandler).not.toBeNull();
          act(() => {
            mockResetViewHandler!();
          });

          // resetControls should be called with true
          expect(
            mockGraphRef.resetControls,
            `resetControls should be called on reset view with ${nodeCount} nodes`
          ).toHaveBeenCalledWith(true);

          // fitNodesInView should be called (at least the direct call from handleResetView)
          expect(
            mockGraphRef.fitNodesInView,
            `fitNodesInView should be called on reset view with ${nodeCount} nodes`
          ).toHaveBeenCalled();
        }
      ),
      { numRuns: 15 }
    );
  });

  /**
   * Property 2d: Search filtering changes node subset → effect re-triggers
   *
   * **Validates: Requirements 3.2**
   *
   * Observation: When search query changes and causes visibleReagraph.nodes.length
   * to change, the fitNodesInView effect re-triggers. We simulate this by changing
   * the mock node data (as search filtering would produce a different node subset).
   *
   * Note: Since we mock useGraphData, we test the effect dependency on
   * visibleReagraph.nodes.length by changing the mock data and re-rendering.
   */
  it("should re-trigger fitNodesInView effect when node count changes due to filtering", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 50 }),
        fc.integer({ min: 1, max: 4 }),
        (initialCount, reducedCount) => {
          // Ensure reduced is strictly less than initial
          const actualReduced = Math.min(reducedCount, initialCount - 1);
          if (actualReduced < 1) return;

          cleanup();

          mockReagraphNodes = generateNodes(initialCount);
          mockReagraphEdges = generateEdges(initialCount);

          mockGraphRef = {
            fitNodesInView: vi.fn(),
            resetControls: vi.fn(),
            zoomIn: vi.fn(),
            zoomOut: vi.fn(),
          };

          // Mount with initial nodes
          const { rerender } = render(React.createElement(GraphView));

          act(() => {
            vi.advanceTimersByTime(4000);
          });

          const callsAfterInitial = mockGraphRef.fitNodesInView.mock.calls.length;

          // Simulate search filtering by changing the mock data to a smaller subset
          mockReagraphNodes = generateNodes(actualReduced);
          mockReagraphEdges = generateEdges(actualReduced);

          // Re-render to pick up the new mock data
          act(() => {
            rerender(React.createElement(GraphView));
          });

          act(() => {
            vi.advanceTimersByTime(4000);
          });

          const callsAfterFilter = mockGraphRef.fitNodesInView.mock.calls.length;

          // The effect should have re-triggered since nodes.length changed
          expect(
            callsAfterFilter,
            `fitNodesInView should be called again after node count changed from ` +
            `${initialCount} to ${actualReduced}. Calls: before=${callsAfterInitial}, after=${callsAfterFilter}`
          ).toBeGreaterThan(callsAfterInitial);
        }
      ),
      { numRuns: 15 }
    );
  });
});
