import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphCanvasRef } from "reagraph";
import { useGraphData } from "../hooks/useGraphData";
import { apiClient } from "../services/api";
import { useGraphStore } from "../stores/useGraphStore";
import { GraphCanvas } from "./GraphCanvas";
import { GraphControls } from "./GraphControls";
import { GraphSidebar } from "./GraphSidebar";
import { NodeDetailPanel } from "./NodeDetailPanel";

interface DocumentOption {
  id: string;
  label: string;
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function textMatches(query: string, parts: string[]): boolean {
  if (query.length === 0) {
    return true;
  }

  return parts.some((part) => part.toLowerCase().includes(query));
}

export function GraphView() {
  const {
    graph: { nodes, edges },
    reagraph,
    isLoading,
    error,
    loadInitialGraphData,
    expandNode
  } = useGraphData({
    autoLoad: false,
    defaultMaxDepth: 2,
    initialLoadLimit: 100,
    initialFetchMaxNodes: 200
  });

  const selectedNodeId = useGraphStore((state) => state.selectedNodeId);
  const hoveredNodeId = useGraphStore((state) => state.hoveredNodeId);
  const layoutMode = useGraphStore((state) => state.layoutMode);
  const filters = useGraphStore((state) => state.filters);
  const setSelectedNodeId = useGraphStore((state) => state.setSelectedNodeId);
  const setHoveredNodeId = useGraphStore((state) => state.setHoveredNodeId);
  const setLayoutMode = useGraphStore((state) => state.setLayoutMode);
  const setSearchQuery = useGraphStore((state) => state.setSearchQuery);
  const setMinConfidence = useGraphStore((state) => state.setMinConfidence);
  const toggleNodeTypeFilter = useGraphStore((state) => state.toggleNodeTypeFilter);
  const toggleDocumentFilter = useGraphStore((state) => state.toggleDocumentFilter);
  const clearFilters = useGraphStore((state) => state.clearFilters);

  const graphRef = useRef<GraphCanvasRef | null>(null);

  const [documentOptions, setDocumentOptions] = useState<DocumentOption[]>([]);
  const [viewError, setViewError] = useState<string | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);

  useEffect(() => {
    void loadInitialGraphData();
  }, [loadInitialGraphData]);

  useEffect(() => {
    const controller = new AbortController();

    const loadDocuments = async () => {
      try {
        const result = await apiClient.documents.list({
          page: 1,
          pageSize: 300,
          signal: controller.signal
        });
        const options = result.items.map((document) => ({
          id: document.id,
          label: document.filename
        }));
        setDocumentOptions(options);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
      }
    };

    void loadDocuments();

    return () => controller.abort();
  }, []);

  const nodeTypes = useMemo(
    () => Array.from(new Set(nodes.map((node) => node.type))).sort((a, b) => a.localeCompare(b)),
    [nodes]
  );

  const documentOptionsFromGraph = useMemo(() => {
    const docIds = new Set<string>();
    for (const node of nodes) {
      for (const documentId of node.sourceDocumentIds) {
        docIds.add(documentId);
      }
    }

    const knownLabels = new Map(documentOptions.map((item) => [item.id, item.label]));
    return Array.from(docIds)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({
        id,
        label: knownLabels.get(id) ?? id
      }));
  }, [documentOptions, nodes]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const selectedNodeNeighbors = useMemo(() => {
    if (!selectedNode) {
      return [];
    }

    const neighborIdSet = new Set<string>();
    for (const edge of edges) {
      if (edge.sourceNodeId === selectedNode.id) {
        neighborIdSet.add(edge.targetNodeId);
      }
      if (edge.targetNodeId === selectedNode.id) {
        neighborIdSet.add(edge.sourceNodeId);
      }
    }

    return nodes
      .filter((node) => neighborIdSet.has(node.id))
      .map((node) => node.name)
      .sort((a, b) => a.localeCompare(b));
  }, [edges, nodes, selectedNode]);

  const selectedNodeDegree = useMemo(() => {
    if (!selectedNode) {
      return 0;
    }

    let degree = 0;
    for (const edge of edges) {
      if (edge.sourceNodeId === selectedNode.id || edge.targetNodeId === selectedNode.id) {
        degree += 1;
      }
    }
    return degree;
  }, [edges, selectedNode]);

  const normalizedQuery = normalizeSearch(filters.searchQuery);

  const searchContext = useMemo(() => {
    if (normalizedQuery.length === 0) {
      return {
        highlightedNodeIds: [] as string[],
        visibleNodeIds: new Set(nodes.map((node) => node.id))
      };
    }

    const highlightedNodeIds = nodes
      .filter((node) =>
        textMatches(normalizedQuery, [node.name, node.type, node.description])
      )
      .map((node) => node.id);

    const visibleNodeIds = new Set(highlightedNodeIds);
    for (const edge of edges) {
      if (visibleNodeIds.has(edge.sourceNodeId) || visibleNodeIds.has(edge.targetNodeId)) {
        visibleNodeIds.add(edge.sourceNodeId);
        visibleNodeIds.add(edge.targetNodeId);
      }
    }

    return {
      highlightedNodeIds,
      visibleNodeIds
    };
  }, [edges, nodes, normalizedQuery]);

  const visibleReagraph = useMemo(() => {
    if (normalizedQuery.length === 0) {
      return reagraph;
    }

    const visibleNodeIds = searchContext.visibleNodeIds;
    const filteredNodes = reagraph.nodes.filter((node) => visibleNodeIds.has(node.id));
    const filteredNodeSet = new Set(filteredNodes.map((node) => node.id));
    const filteredEdges = reagraph.edges.filter(
      (edge) => filteredNodeSet.has(edge.source) && filteredNodeSet.has(edge.target)
    );

    return {
      nodes: filteredNodes,
      edges: filteredEdges
    };
  }, [normalizedQuery, reagraph, searchContext.visibleNodeIds]);

  useEffect(() => {
    if (visibleReagraph.nodes.length === 0) {
      setSelectedNodeId(null);
      return;
    }

    const hasSelectedNode = selectedNodeId
      ? visibleReagraph.nodes.some((node) => node.id === selectedNodeId)
      : false;
    if (!hasSelectedNode) {
      const firstNodeId = visibleReagraph.nodes[0]?.id ?? null;
      setSelectedNodeId(firstNodeId);
    }
  }, [selectedNodeId, setSelectedNodeId, visibleReagraph.nodes]);

  const handleExpandNode = useCallback(
    async (nodeId: string) => {
      if (expandedNodeIds.has(nodeId)) {
        return;
      }

      setExpandingNodeId(nodeId);
      setViewError(null);

      try {
        await expandNode({
          nodeId,
          depth: 1,
          maxNodes: 120
        });
        setExpandedNodeIds((current) => {
          const next = new Set(current);
          next.add(nodeId);
          return next;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to expand node";
        setViewError(message);
      } finally {
        setExpandingNodeId(null);
      }
    },
    [expandNode, expandedNodeIds]
  );

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      void handleExpandNode(nodeId);
    },
    [handleExpandNode, setSelectedNodeId]
  );

  const handleResetView = useCallback(() => {
    graphRef.current?.resetControls(true);
    graphRef.current?.fitNodesInView();
  }, []);

  useEffect(() => {
    if (visibleReagraph.nodes.length === 0) {
      return;
    }

    // Immediate fit + delayed fit to handle layout computation timing
    graphRef.current?.fitNodesInView();
    const timer = setTimeout(() => {
      graphRef.current?.fitNodesInView();
    }, 1000);
    return () => clearTimeout(timer);
  }, [layoutMode, visibleReagraph.nodes.length]);

  const activeError = viewError ?? error;

  return (
    <section className="page-shell graph-page-shell">

      <div className="graph-layout">
        <GraphSidebar
          filters={filters}
          nodeTypes={nodeTypes}
          documents={documentOptionsFromGraph}
          onSearchQueryChange={setSearchQuery}
          onMinConfidenceChange={setMinConfidence}
          onToggleNodeType={toggleNodeTypeFilter}
          onToggleDocument={toggleDocumentFilter}
          onClearFilters={() => {
            clearFilters();
            setExpandedNodeIds(new Set());
          }}
        />

        <div className="graph-main-column">
          <GraphControls
            layoutMode={layoutMode}
            onLayoutChange={setLayoutMode}
            onZoomIn={() => graphRef.current?.zoomIn()}
            onZoomOut={() => graphRef.current?.zoomOut()}
            onResetView={handleResetView}
            disabled={isLoading}
          />

          <section className="panel graph-canvas-panel">
            <div className="graph-canvas-head">
              <h3>Graph Canvas</h3>
              <div className="graph-canvas-metrics">
                <span>{visibleReagraph.nodes.length} nodes</span>
                <span>{visibleReagraph.edges.length} edges</span>
                <button
                  type="button"
                  className="docs-action-button"
                  onClick={() => {
                    setExpandedNodeIds(new Set());
                    void loadInitialGraphData();
                  }}
                  disabled={isLoading}
                >
                  {isLoading ? "Loading..." : "Reload Top-N"}
                </button>
              </div>
            </div>

            <div className="graph-canvas-inner">
              {isLoading && (
                <div className="graph-loading-overlay">
                  <div className="graph-loading-spinner" />
                  <span>Loading graph data...</span>
                </div>
              )}
              <GraphCanvas
                graphRef={graphRef}
                nodes={visibleReagraph.nodes}
                edges={visibleReagraph.edges}
                layoutMode={layoutMode}
                selectedNodeId={selectedNodeId}
                hoveredNodeId={hoveredNodeId}
                highlightedNodeIds={searchContext.highlightedNodeIds}
                onNodeClick={handleNodeClick}
                onNodeHover={setHoveredNodeId}
                onCanvasClick={() => {
                  setHoveredNodeId(null);
                  setSelectedNodeId(null);
                }}
              />
            </div>
          </section>
        </div>

        <NodeDetailPanel
          node={selectedNode}
          degree={selectedNodeDegree}
          neighborNames={selectedNodeNeighbors}
          isExpanding={expandingNodeId === selectedNode?.id}
          onExpand={(node) => {
            void handleExpandNode(node.id);
          }}
          onClose={() => {
            setSelectedNodeId(null);
            setHoveredNodeId(null);
          }}
          onFilterDocument={(documentId) => {
            if (!filters.documentIds.includes(documentId)) {
              toggleDocumentFilter(documentId);
            }
          }}
        />
      </div>

      {activeError ? <p className="docs-error-banner">{activeError}</p> : null}
    </section>
  );
}
