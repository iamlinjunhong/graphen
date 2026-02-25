import { useCallback, useEffect, useMemo, useState } from "react";
import type { GraphEdge, GraphNode } from "@graphen/shared";
import { apiClient } from "../services/api";
import { useGraphStore } from "../stores/useGraphStore";

export interface ReagraphNode {
  id: string;
  label: string;
  fill: string;
  size: number;
  data: GraphNode;
}

export interface ReagraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  size: number;
  data: GraphEdge;
}

interface ReagraphData {
  nodes: ReagraphNode[];
  edges: ReagraphEdge[];
}

interface LoadGraphParams {
  centerNodeIds?: string[];
  maxNodes?: number;
  maxDepth?: number;
}

interface ExpandNodeParams {
  nodeId: string;
  depth?: number;
  maxNodes?: number;
}

interface UseGraphDataOptions {
  autoLoad?: boolean;
  defaultMaxNodes?: number;
  defaultMaxDepth?: number;
  initialFetchMaxNodes?: number;
  initialLoadLimit?: number;
}

const ENTITY_TYPE_COLORS: Record<string, string> = {
  Person: "#c4683f",
  Technology: "#229288",
  Organization: "#3d9863",
  Concept: "#3566b8",
  Document: "#d89f38",
  Event: "#cc5a6c",
  Location: "#7f6ad4",
  Metric: "#63717a"
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mapNodeColor(nodeType: string): string {
  return ENTITY_TYPE_COLORS[nodeType] ?? "#8f8b80";
}

function buildDegreeMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const degreeMap = new Map<string, number>();
  for (const node of nodes) {
    degreeMap.set(node.id, 0);
  }
  for (const edge of edges) {
    degreeMap.set(edge.sourceNodeId, (degreeMap.get(edge.sourceNodeId) ?? 0) + 1);
    degreeMap.set(edge.targetNodeId, (degreeMap.get(edge.targetNodeId) ?? 0) + 1);
  }
  return degreeMap;
}

function trimSubgraphByDegree(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxNodes: number
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (nodes.length <= maxNodes) {
    return { nodes, edges };
  }

  const degreeMap = buildDegreeMap(nodes, edges);
  const orderedNodes = [...nodes].sort((a, b) => {
    const degreeDelta = (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0);
    if (degreeDelta !== 0) {
      return degreeDelta;
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
  const selectedNodes = orderedNodes.slice(0, maxNodes);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges.filter(
    (edge) => selectedIds.has(edge.sourceNodeId) && selectedIds.has(edge.targetNodeId)
  );
  return {
    nodes: selectedNodes,
    edges: selectedEdges
  };
}

function buildReagraphData(nodes: GraphNode[], edges: GraphEdge[]): ReagraphData {
  const degreeMap = buildDegreeMap(nodes, edges);

  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      label: node.name,
      fill: mapNodeColor(node.type),
      size: clamp(16 + (degreeMap.get(node.id) ?? 0) * 3, 16, 42),
      data: node
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      label: edge.relationType,
      size: clamp(edge.weight * 1.5, 1, 6),
      data: edge
    }))
  };
}

export function useGraphData(options: UseGraphDataOptions = {}) {
  const {
    autoLoad = true,
    defaultMaxNodes = 240,
    defaultMaxDepth = 2,
    initialFetchMaxNodes = 420,
    initialLoadLimit = 160
  } = options;

  const nodes = useGraphStore((state) => state.nodes);
  const edges = useGraphStore((state) => state.edges);
  const filters = useGraphStore((state) => state.filters);
  const setGraphData = useGraphStore((state) => state.setGraphData);
  const appendSubgraph = useGraphStore((state) => state.appendSubgraph);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGraphData = useCallback(async (params: LoadGraphParams = {}) => {
    setIsLoading(true);
    setError(null);

    try {
      const query: {
        centerNodeIds?: string[];
        nodeTypes?: string[];
        documentIds?: string[];
        minConfidence?: number;
        maxNodes: number;
        maxDepth: number;
      } = {
        maxNodes: params.maxNodes ?? defaultMaxNodes,
        maxDepth: params.maxDepth ?? defaultMaxDepth
      };
      if (params.centerNodeIds && params.centerNodeIds.length > 0) {
        query.centerNodeIds = params.centerNodeIds;
      }
      if (filters.nodeTypes.length > 0) {
        query.nodeTypes = filters.nodeTypes;
      }
      if (filters.documentIds.length > 0) {
        query.documentIds = filters.documentIds;
      }
      if (filters.minConfidence > 0) {
        query.minConfidence = filters.minConfidence;
      }

      const subgraph = await apiClient.graph.getSubgraph({
        ...query
      });

      setGraphData(subgraph);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load graph data";
      setError(message);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [defaultMaxDepth, defaultMaxNodes, filters.documentIds, filters.minConfidence, filters.nodeTypes, setGraphData]);

  const loadInitialGraphData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const query: {
        nodeTypes?: string[];
        documentIds?: string[];
        minConfidence?: number;
        maxNodes: number;
        maxDepth: number;
      } = {
        maxNodes: initialFetchMaxNodes,
        maxDepth: defaultMaxDepth
      };
      if (filters.nodeTypes.length > 0) {
        query.nodeTypes = filters.nodeTypes;
      }
      if (filters.documentIds.length > 0) {
        query.documentIds = filters.documentIds;
      }
      if (filters.minConfidence > 0) {
        query.minConfidence = filters.minConfidence;
      }

      const subgraph = await apiClient.graph.getSubgraph(query);
      const trimmed = trimSubgraphByDegree(
        subgraph.nodes,
        subgraph.edges,
        Math.max(12, initialLoadLimit)
      );
      setGraphData(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load initial graph";
      setError(message);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [
    defaultMaxDepth,
    filters.documentIds,
    filters.minConfidence,
    filters.nodeTypes,
    initialFetchMaxNodes,
    initialLoadLimit,
    setGraphData
  ]);

  const expandNode = useCallback(async (params: ExpandNodeParams) => {
    setIsLoading(true);
    setError(null);

    try {
      const subgraph = await apiClient.graph.getNeighbors(params.nodeId, {
        depth: params.depth ?? 1,
        maxNodes: params.maxNodes ?? 120
      });
      appendSubgraph(subgraph);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to expand graph node";
      setError(message);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [appendSubgraph]);

  useEffect(() => {
    if (!autoLoad) {
      return;
    }

    void loadInitialGraphData();
  }, [autoLoad, loadInitialGraphData]);

  const reagraph = useMemo(() => buildReagraphData(nodes, edges), [edges, nodes]);

  return {
    isLoading,
    error,
    graph: {
      nodes,
      edges
    },
    reagraph,
    loadInitialGraphData,
    loadGraphData,
    expandNode
  };
}
