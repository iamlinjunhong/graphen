import { Search, X } from "lucide-react";
import type { GraphFilters } from "../stores/useGraphStore";

interface DocumentFilterOption {
  id: string;
  label: string;
}

interface GraphSidebarProps {
  filters: GraphFilters;
  nodeTypes: string[];
  documents: DocumentFilterOption[];
  onSearchQueryChange: (query: string) => void;
  onMinConfidenceChange: (value: number) => void;
  onToggleNodeType: (nodeType: string) => void;
  onToggleDocument: (documentId: string) => void;
  onClearFilters: () => void;
}

function isChecked(list: string[], value: string): boolean {
  return list.includes(value);
}

export function GraphSidebar({
  filters,
  nodeTypes,
  documents,
  onSearchQueryChange,
  onMinConfidenceChange,
  onToggleNodeType,
  onToggleDocument,
  onClearFilters
}: GraphSidebarProps) {
  return (
    <aside className="side-panel graph-sidebar">
      {/* Header */}
      <div className="side-panel-header">
        <h3 className="side-panel-title">Graph Navigation</h3>
        <button
          type="button"
          className="icon-button"
          style={{ width: 28, height: 28, fontSize: 12 }}
          title="Clear filters"
          onClick={onClearFilters}
          aria-label="Clear filters"
        >
          <X size={13} />
        </button>
      </div>

      {/* Filter content */}
      <div className="graph-sidebar-inner">

        {/* Search */}
        <div className="graph-sidebar-field">
          <span>Search Nodes</span>
          <div className="side-search-wrap" style={{ flex: "none" }}>
            <span className="search-icon">
              <Search size={14} />
            </span>
            <input
              className="side-search-input"
              value={filters.searchQuery}
              onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
              placeholder="Search by name/type..."
              aria-label="Search graph nodes"
            />
          </div>
        </div>

        {/* Confidence range */}
        <div className="graph-sidebar-field">
          <span>Min Confidence: {filters.minConfidence.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={filters.minConfidence}
            onChange={(event) => onMinConfidenceChange(Number(event.currentTarget.value))}
            aria-label="Min confidence"
            style={{ accentColor: "var(--accent-primary)", width: "100%" }}
          />
        </div>

        {/* Entity types */}
        <div className="graph-filter-group">
          <h4>Entity Types</h4>
          <div className="graph-filter-options">
            {nodeTypes.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.85rem" }}>No node types</p>
            ) : (
              nodeTypes.map((nodeType) => (
                <label key={nodeType} className="graph-checkbox-item">
                  <input
                    type="checkbox"
                    checked={isChecked(filters.nodeTypes, nodeType)}
                    onChange={() => onToggleNodeType(nodeType)}
                  />
                  <span>{nodeType}</span>
                </label>
              ))
            )}
          </div>
        </div>

        {/* Source documents */}
        <div className="graph-filter-group">
          <h4>Source Documents</h4>
          <div className="graph-filter-options">
            {documents.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.85rem" }}>No documents</p>
            ) : (
              documents.map((document) => (
                <label key={document.id} className="graph-checkbox-item">
                  <input
                    type="checkbox"
                    checked={isChecked(filters.documentIds, document.id)}
                    onChange={() => onToggleDocument(document.id)}
                  />
                  <span>{document.label}</span>
                </label>
              ))
            )}
          </div>
        </div>

      </div>
    </aside>
  );
}
