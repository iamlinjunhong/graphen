import { create } from "zustand";
import type { GraphEdge, GraphNode } from "@graphen/shared";

export type GraphLayoutMode = "force" | "radial" | "tree" | "force-3d";

export interface GraphFilters {
  nodeTypes: string[];
  documentIds: string[];
  minConfidence: number;
  searchQuery: string;
}

interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  layoutMode: GraphLayoutMode;
  filters: GraphFilters;
  setGraphData: (payload: { nodes: GraphNode[]; edges: GraphEdge[] }) => void;
  appendSubgraph: (payload: { nodes: GraphNode[]; edges: GraphEdge[] }) => void;
  setSelectedNodeId: (nodeId: string | null) => void;
  setHoveredNodeId: (nodeId: string | null) => void;
  setLayoutMode: (mode: GraphLayoutMode) => void;
  setSearchQuery: (query: string) => void;
  setMinConfidence: (value: number) => void;
  toggleNodeTypeFilter: (nodeType: string) => void;
  toggleDocumentFilter: (documentId: string) => void;
  clearFilters: () => void;
  reset: () => void;
}

const defaultFilters: GraphFilters = {
  nodeTypes: [],
  documentIds: [],
  minConfidence: 0,
  searchQuery: ""
};

function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  const map = new Map<string, GraphNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return [...map.values()];
}

function uniqueEdges(edges: GraphEdge[]): GraphEdge[] {
  const map = new Map<string, GraphEdge>();
  for (const edge of edges) {
    map.set(edge.id, edge);
  }
  return [...map.values()];
}

function toggleString(items: string[], target: string): string[] {
  return items.includes(target)
    ? items.filter((item) => item !== target)
    : [...items, target];
}

export const useGraphStore = create<GraphState>((set) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  hoveredNodeId: null,
  layoutMode: "force",
  filters: defaultFilters,
  setGraphData: (payload) =>
    set((state) => {
      const selectedNodeStillExists =
        state.selectedNodeId !== null &&
        payload.nodes.some((node) => node.id === state.selectedNodeId);
      const hoveredNodeStillExists =
        state.hoveredNodeId !== null &&
        payload.nodes.some((node) => node.id === state.hoveredNodeId);
      return {
        nodes: uniqueNodes(payload.nodes),
        edges: uniqueEdges(payload.edges),
        selectedNodeId: selectedNodeStillExists ? state.selectedNodeId : null,
        hoveredNodeId: hoveredNodeStillExists ? state.hoveredNodeId : null
      };
    }),
  appendSubgraph: (payload) =>
    set((state) => ({
      nodes: uniqueNodes([...state.nodes, ...payload.nodes]),
      edges: uniqueEdges([...state.edges, ...payload.edges])
    })),
  setSelectedNodeId: (nodeId) => set({ selectedNodeId: nodeId }),
  setHoveredNodeId: (nodeId) => set({ hoveredNodeId: nodeId }),
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setSearchQuery: (query) =>
    set((state) => ({
      filters: {
        ...state.filters,
        searchQuery: query
      }
    })),
  setMinConfidence: (value) =>
    set((state) => ({
      filters: {
        ...state.filters,
        minConfidence: Math.max(0, Math.min(1, value))
      }
    })),
  toggleNodeTypeFilter: (nodeType) =>
    set((state) => ({
      filters: {
        ...state.filters,
        nodeTypes: toggleString(state.filters.nodeTypes, nodeType)
      }
    })),
  toggleDocumentFilter: (documentId) =>
    set((state) => ({
      filters: {
        ...state.filters,
        documentIds: toggleString(state.filters.documentIds, documentId)
      }
    })),
  clearFilters: () =>
    set({
      filters: defaultFilters
    }),
  reset: () =>
    set({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      hoveredNodeId: null,
      layoutMode: "force",
      filters: defaultFilters
    })
}));
