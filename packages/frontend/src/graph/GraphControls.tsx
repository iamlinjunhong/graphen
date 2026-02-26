import { useState } from "react";
import type { GraphLayoutMode } from "../stores/useGraphStore";
import { apiClient } from "../services/api";

interface GraphControlsProps {
  layoutMode: GraphLayoutMode;
  onLayoutChange: (layout: GraphLayoutMode) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  disabled?: boolean;
}

export function GraphControls({
  layoutMode,
  onLayoutChange,
  onZoomIn,
  onZoomOut,
  onResetView,
  disabled
}: GraphControlsProps) {
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: "jsonld" | "cypher") => {
    setExporting(true);
    try {
      const result = await apiClient.graph.exportGraph(format);
      const ext = format === "cypher" ? "cypher" : "jsonld";
      const mimeType = format === "cypher" ? "text/plain" : "application/ld+json";
      const blob = new Blob([result.data], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `graph-export.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently fail — user can retry
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="panel graph-controls" aria-label="Graph controls">
      <div className="graph-controls-group">
        <span>Layout</span>
        <div className="graph-segmented">
          <button
            type="button"
            className={layoutMode === "force" ? "is-active" : ""}
            onClick={() => onLayoutChange("force")}
            disabled={disabled}
          >
            Force
          </button>
          <button
            type="button"
            className={layoutMode === "radial" ? "is-active" : ""}
            onClick={() => onLayoutChange("radial")}
            disabled={disabled}
          >
            Radial
          </button>
          <button
            type="button"
            className={layoutMode === "tree" ? "is-active" : ""}
            onClick={() => onLayoutChange("tree")}
            disabled={disabled}
          >
            Tree
          </button>
        </div>
      </div>

      <div className="graph-controls-group">
        <span>Viewport</span>
        <div className="graph-segmented">
          <button type="button" onClick={onZoomOut} disabled={disabled}>
            -
          </button>
          <button type="button" onClick={onZoomIn} disabled={disabled}>
            +
          </button>
          <button type="button" onClick={onResetView} disabled={disabled}>
            Fit
          </button>
        </div>
      </div>

      <div className="graph-controls-group">
        <span>Export</span>
        <div className="graph-segmented">
          <button
            type="button"
            onClick={() => void handleExport("jsonld")}
            disabled={disabled || exporting}
          >
            JSON-LD
          </button>
          <button
            type="button"
            onClick={() => void handleExport("cypher")}
            disabled={disabled || exporting}
          >
            Cypher
          </button>
        </div>
      </div>
    </section>
  );
}
