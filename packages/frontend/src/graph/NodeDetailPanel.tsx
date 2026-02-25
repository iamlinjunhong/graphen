import { AnimatePresence, motion } from "framer-motion";
import type { GraphNode } from "@graphen/shared";

interface NodeDetailPanelProps {
  node: GraphNode | null;
  degree: number;
  neighborNames: string[];
  isExpanding: boolean;
  onExpand: (node: GraphNode) => void;
  onClose: () => void;
  onFilterDocument: (documentId: string) => void;
}

export function NodeDetailPanel({
  node,
  degree,
  neighborNames,
  isExpanding,
  onExpand,
  onClose,
  onFilterDocument
}: NodeDetailPanelProps) {
  return (
    <AnimatePresence>
      {node ? (
        <motion.aside
          className="node-detail-panel"
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <header>
            <p className="page-kicker">Node Detail</p>
            <h3>{node.name}</h3>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close detail panel">
              ✕
            </button>
          </header>

          <section>
            <span className="chip">{node.type}</span>
            <p>{node.description || "No description."}</p>
          </section>

          <section className="node-detail-stats">
            <div>
              <span>Confidence</span>
              <strong>{node.confidence.toFixed(2)}</strong>
            </div>
            <div>
              <span>Degree</span>
              <strong>{degree}</strong>
            </div>
            <div>
              <span>Neighbors</span>
              <strong>{neighborNames.length}</strong>
            </div>
          </section>

          <section>
            <h4>Source Documents</h4>
            <div className="node-detail-docs">
              {node.sourceDocumentIds.length === 0 ? (
                <p className="muted">No source documents</p>
              ) : (
                node.sourceDocumentIds.map((documentId) => (
                  <button
                    key={documentId}
                    type="button"
                    className="chip"
                    onClick={() => onFilterDocument(documentId)}
                  >
                    {documentId}
                  </button>
                ))
              )}
            </div>
          </section>

          <section>
            <h4>Connected Entities</h4>
            <div className="node-detail-neighbors">
              {neighborNames.length === 0 ? (
                <p className="muted">No neighbors in current subgraph</p>
              ) : (
                neighborNames.slice(0, 20).map((name) => <span key={name}>{name}</span>)
              )}
            </div>
          </section>

          <footer>
            <button type="button" className="docs-action-button" disabled={isExpanding} onClick={() => onExpand(node)}>
              {isExpanding ? "Expanding..." : "Load Neighbors"}
            </button>
          </footer>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
