import type { GraphLayoutMode } from "../stores/useGraphStore";

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
    </section>
  );
}
