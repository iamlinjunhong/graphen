import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import type { MemoryEvidence, MemoryFact, ReviewAction } from "@graphen/shared";
import { MemoryStatusBadge } from "./MemoryStatusBadge";
import { MemoryEvidenceList } from "./MemoryEvidenceList";
import { useMemoryStore } from "../stores/useMemoryStore";

interface MemoryFactCardProps {
  fact: MemoryFact;
  compact?: boolean;
  evidence?: MemoryEvidence[];
  onReview?: (factId: string, action: ReviewAction) => void;
}

export function MemoryFactCard({ fact, compact = false, evidence, onReview }: MemoryFactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const loadEvidence = useMemoryStore((s) => s.loadEvidence);
  const storedEvidence = useMemoryStore((s) => s.evidenceByFactId[fact.id]);

  const displayEvidence = evidence ?? storedEvidence ?? [];
  const objectDisplay = fact.objectText ?? fact.objectNodeId ?? "";
  const isConflicted = fact.reviewStatus === "conflicted";

  function handleToggle() {
    if (compact) return;
    const next = !expanded;
    setExpanded(next);
    if (next && displayEvidence.length === 0) {
      loadEvidence(fact.id);
    }
  }

  const cardClass = [
    "memory-fact-card",
    compact && "is-compact",
    isConflicted && "is-conflicted",
  ].filter(Boolean).join(" ");

  return (
    <div className={cardClass}>
      <div className="memory-fact-head" onClick={handleToggle}>
        <MemoryStatusBadge status={fact.reviewStatus} />
        <div className="memory-fact-triple">
          <span className="memory-fact-subject">{fact.subjectNodeId}</span>
          <span className="memory-fact-arrow">→</span>
          <span className="memory-fact-predicate">{fact.predicate}</span>
          <span className="memory-fact-arrow">→</span>
          <span className="memory-fact-object">{objectDisplay}</span>
        </div>
        <span className="memory-fact-confidence">{fact.confidence.toFixed(2)}</span>
        {!compact && isConflicted && <AlertTriangle size={14} className="memory-conflict-icon" />}
        {!compact && (
          <button type="button" className="memory-fact-toggle" aria-label={expanded ? "收起" : "展开"}>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {!compact && (
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              style={{ overflow: "hidden" }}
            >
              {isConflicted ? (
                <div className="memory-conflict-section">
                  <div className="memory-conflict-label">
                    <AlertTriangle size={14} />
                    <span>该事实存在冲突，建议在记忆编织页面处理。</span>
                  </div>
                </div>
              ) : null}

              <div className="memory-fact-evidence">
                <MemoryEvidenceList evidence={displayEvidence} />
              </div>
              <div className="memory-fact-actions">
                {fact.reviewStatus !== "confirmed" && (
                  <button
                    type="button"
                    className="docs-action-button"
                    onClick={() => onReview?.(fact.id, "confirm")}
                  >
                    确认
                  </button>
                )}
                {fact.reviewStatus !== "rejected" && (
                  <button
                    type="button"
                    className="docs-action-button is-danger"
                    onClick={() => onReview?.(fact.id, "reject")}
                  >
                    拒绝
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
