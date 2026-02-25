import { useMemo, type RefObject } from "react";
import type { LayoutTypes } from "reagraph";
import { GraphCanvas as ReagraphGraphCanvas, type GraphCanvasRef } from "reagraph";
import type { GraphLayoutMode } from "../stores/useGraphStore";
import type { ReagraphEdge, ReagraphNode } from "../hooks/useGraphData";

interface GraphCanvasProps {
  graphRef: RefObject<GraphCanvasRef | null>;
  nodes: ReagraphNode[];
  edges: ReagraphEdge[];
  layoutMode: GraphLayoutMode;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  highlightedNodeIds: string[];
  onNodeClick: (nodeId: string) => void;
  onNodeHover: (nodeId: string | null) => void;
  onCanvasClick: () => void;
}

function resolveLayoutType(mode: GraphLayoutMode): LayoutTypes {
  switch (mode) {
    case "radial":
      return "radialOut2d";
    case "tree":
      return "treeTd2d";
    case "force-3d":
      return "forceDirected3d";
    case "force":
    default:
      return "forceDirected2d";
  }
}

export function GraphCanvas({
  graphRef,
  nodes,
  edges,
  layoutMode,
  selectedNodeId,
  hoveredNodeId,
  highlightedNodeIds,
  onNodeClick,
  onNodeHover,
  onCanvasClick
}: GraphCanvasProps) {
  const hoverContext = useMemo(() => {
    if (!hoveredNodeId) {
      return {
        neighborIds: new Set<string>(),
        activeEdgeIds: new Set<string>()
      };
    }

    const neighborIds = new Set<string>([hoveredNodeId]);
    const activeEdgeIds = new Set<string>();

    for (const edge of edges) {
      if (edge.source === hoveredNodeId) {
        neighborIds.add(edge.target);
        activeEdgeIds.add(edge.id);
      } else if (edge.target === hoveredNodeId) {
        neighborIds.add(edge.source);
        activeEdgeIds.add(edge.id);
      }
    }

    return { neighborIds, activeEdgeIds };
  }, [edges, hoveredNodeId]);

  const highlightSet = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);

  const hasFocus = hoveredNodeId !== null || highlightSet.size > 0;

  const canvasNodes = useMemo(
    () =>
      nodes.map((node) => {
        const isHoveredContext = hoveredNodeId ? hoverContext.neighborIds.has(node.id) : false;
        const isSearchHit = highlightSet.has(node.id);
        const shouldDim = hasFocus && !isHoveredContext && !isSearchHit;

        return {
          id: node.id,
          label: node.label,
          fill: shouldDim ? "#b5b2a8" : node.fill,
          size: node.id === selectedNodeId ? node.size + 4 : node.size,
          data: node.data
        };
      }),
    [hasFocus, highlightSet, hoverContext.neighborIds, hoveredNodeId, nodes, selectedNodeId]
  );

  const canvasEdges = useMemo(
    () =>
      edges.map((edge) => {
        const isHoverEdge = hoveredNodeId ? hoverContext.activeEdgeIds.has(edge.id) : false;
        const isSearchEdge = highlightSet.has(edge.source) || highlightSet.has(edge.target);
        const shouldDim = hasFocus && !isHoverEdge && !isSearchEdge;

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          size: edge.size,
          fill: shouldDim ? "#c8c5bc" : "#80796f",
          data: edge.data
        };
      }),
    [edges, hasFocus, highlightSet, hoverContext.activeEdgeIds, hoveredNodeId]
  );

  const selections = selectedNodeId ? [selectedNodeId] : undefined;
  const activeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of highlightSet) {
      ids.add(id);
    }
    for (const id of hoverContext.neighborIds) {
      ids.add(id);
    }
    for (const edgeId of hoverContext.activeEdgeIds) {
      ids.add(edgeId);
    }
    return ids.size > 0 ? Array.from(ids) : undefined;
  }, [highlightSet, hoverContext.activeEdgeIds, hoverContext.neighborIds]);

  const optionalSelectionProps = selections ? { selections } : {};
  const optionalActiveProps = activeIds ? { actives: activeIds } : {};

  return (
    <div className="graph-canvas-shell">
      <ReagraphGraphCanvas
        ref={graphRef}
        nodes={canvasNodes}
        edges={canvasEdges}
        {...optionalSelectionProps}
        {...optionalActiveProps}
        draggable
        animated
        labelType="nodes"
        edgeArrowPosition="end"
        layoutType={resolveLayoutType(layoutMode)}
        cameraMode="pan"
        minDistance={250}
        maxDistance={6000}
        minZoom={0.5}
        maxZoom={8}
        glOptions={{ preserveDrawingBuffer: true }}
        onNodeClick={(node) => onNodeClick(node.id)}
        onNodePointerOver={(node) => onNodeHover(node.id)}
        onNodePointerOut={() => onNodeHover(null)}
        onCanvasClick={onCanvasClick}
      />
    </div>
  );
}
