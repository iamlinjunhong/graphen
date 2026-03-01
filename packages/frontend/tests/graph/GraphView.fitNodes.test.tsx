/**
 * Bug Condition Exploration Test - Property 1: Fault Condition
 *
 * 首次挂载时 fitNodesInView 在布局稳定前被调用
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2**
 *
 * This test proves the bug exists: on first mount, fitNodesInView is called
 * using fixed delays [300, 800, 1500, 3000] without any layout stability detection.
 * The test expects to FAIL on unfixed code (confirming the bug).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import * as fc from "fast-check";
import React from "react";

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
let capturedGraphRefSetter: ((ref: MockGraphCanvasRef) => void) | null = null;
let mockReagraphNodes: ReagraphNode[] = [];
let mockReagraphEdges: ReagraphEdge[] = [];
let fitCallTimestamps: number[] = [];
let mountTimestamp = 0;

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
      description: "",
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

// Mock react-router-dom
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/graph", search: "", hash: "", state: null }),
}));

// Mock the API client
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

// Mock useGraphData to control node data
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

// Mock GraphCanvas to capture graphRef and track fitNodesInView calls
vi.mock("../../src/graph/GraphCanvas", () => ({
  GraphCanvas: (props: { graphRef: React.RefObject<MockGraphCanvasRef | null> }) => {
    // Assign our mock ref to the graphRef
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

// Mock GraphControls, GraphSidebar, NodeDetailPanel, GraphQualityPanel
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

// Import GraphView AFTER mocks are set up
const { GraphView } = await import("../../src/graph/GraphView");

describe("Bug Condition Exploration: fitNodesInView timing on first mount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fitCallTimestamps = [];
    mountTimestamp = Date.now();

    mockGraphRef = {
      fitNodesInView: vi.fn(() => {
        fitCallTimestamps.push(Date.now());
      }),
      resetControls: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
    };

    mockReagraphNodes = [];
    mockReagraphEdges = [];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Property 1: Fault Condition - 首次挂载时 fitNodesInView 在布局稳定前被调用
   *
   * **Validates: Requirements 1.2, 2.1, 2.2**
   *
   * Bug condition: isFirstMount=true AND nodesLength>0 AND layoutSettled=false
   *
   * The current implementation uses fixed delays [300, 800, 1500, 3000] to call
   * fitNodesInView. This test verifies that the implementation uses an adaptive
   * retry mechanism that checks layout stability, rather than fixed delays.
   *
   * On UNFIXED code: This test will FAIL because the code uses fixed delays
   * without layout stability detection.
   *
   * On FIXED code: This test will PASS because the code uses adaptive retry
   * with layout stability checking.
   */
  it("should use adaptive retry mechanism instead of fixed delays on first mount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        (nodeCount) => {
          // Reset state for each property run
          fitCallTimestamps = [];
          cleanup();

          // Set up node data BEFORE rendering (simulating data available at mount)
          mockReagraphNodes = generateNodes(nodeCount);
          mockReagraphEdges = generateEdges(nodeCount);

          // Reset the mock for fresh tracking
          mockGraphRef = {
            fitNodesInView: vi.fn(() => {
              fitCallTimestamps.push(Date.now());
            }),
            resetControls: vi.fn(),
            zoomIn: vi.fn(),
            zoomOut: vi.fn(),
          };

          // Mount the component (first mount scenario)
          act(() => {
            render(React.createElement(GraphView));
          });

          // Advance timers to allow all fixed delays to fire
          // The fixed delays are [300, 800, 1500, 3000]
          act(() => {
            vi.advanceTimersByTime(4000);
          });

          const totalCalls = mockGraphRef.fitNodesInView.mock.calls.length;

          // The bug condition: current code calls fitNodesInView at fixed delays
          // [300, 800, 1500, 3000] plus an immediate call = 5 total calls.
          //
          // A correct implementation should NOT use exactly these fixed delays.
          // Instead, it should use an adaptive retry mechanism that checks
          // layout stability before calling fitNodesInView.
          //
          // We verify the bug by checking that the implementation does NOT
          // use the fixed delay pattern [300, 800, 1500, 3000].
          // If it does, the bug condition is confirmed.

          // Check: the code should NOT have exactly 5 calls (1 immediate + 4 fixed delays)
          // at the specific fixed delay timestamps.
          // A correct implementation would use adaptive retries with different timing.

          // Verify that fitNodesInView is NOT called using the fixed delay pattern.
          // The fixed delays are: immediate(0), 300ms, 800ms, 1500ms, 3000ms
          const FIXED_DELAYS = [300, 800, 1500, 3000];
          const hasFixedDelayPattern = totalCalls === FIXED_DELAYS.length + 1;

          // The property: a correct implementation should NOT exhibit the fixed delay pattern.
          // It should use adaptive retry with layout stability detection.
          expect(
            hasFixedDelayPattern,
            `Bug confirmed: fitNodesInView called ${totalCalls} times using fixed delay pattern ` +
            `[immediate, ${FIXED_DELAYS.join(", ")}ms] for ${nodeCount} nodes. ` +
            `Expected adaptive retry mechanism with layout stability detection instead.`
          ).toBe(false);
        }
      ),
      { numRuns: 20 }
    );
  });
});
