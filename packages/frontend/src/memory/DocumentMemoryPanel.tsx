import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { DocumentStatus, MemoryEvidence, MemoryFact, ReviewAction } from "@graphen/shared";
import { useMemoryStore, EMPTY_FACTS } from "../stores/useMemoryStore";
import { MemoryFactCard } from "./MemoryFactCard";

const PROCESSING_STATUSES = new Set<string>(["uploading", "parsing", "extracting", "embedding"]);

interface DocumentMemoryPanelProps {
  documentId: string;
  documentStatus: DocumentStatus;
}

export function DocumentMemoryPanel({ documentId, documentStatus }: DocumentMemoryPanelProps) {
  const facts = useMemoryStore((s) => s.factsByDocumentId[documentId] ?? EMPTY_FACTS);
  const status = useMemoryStore((s) => s.loadingStatus[`doc:${documentId}`] ?? "idle");
  const loadFacts = useMemoryStore((s) => s.loadFactsByDocumentId);
  const reviewFact = useMemoryStore((s) => s.reviewFact);
  const evidenceByFactId = useMemoryStore((s) => s.evidenceByFactId);

  const [collapsed, setCollapsed] = useState(false);

  const isProcessing = PROCESSING_STATUSES.has(documentStatus);

  useEffect(() => {
    if (!isProcessing) {
      loadFacts(documentId);
    }
  }, [documentId, isProcessing, loadFacts]);

  // Group facts by chunkId from evidence
  const chunkGroups = useMemo(() => {
    const groups = new Map<string, MemoryFact[]>();
    for (const fact of facts) {
      // Try to find chunkId from stored evidence, fallback to "unknown"
      const ev = evidenceByFactId[fact.id];
      let chunkKey = "其他";
      if (ev && ev.length > 0) {
        const docEvidence = ev.find((e) => e.documentId === documentId && e.chunkId);
        if (docEvidence?.chunkId) {
          chunkKey = `Chunk #${docEvidence.chunkId}`;
        }
      }
      const list = groups.get(chunkKey) ?? [];
      list.push(fact);
      groups.set(chunkKey, list);
    }
    // If no evidence loaded yet, show all facts in a single group
    if (groups.size === 0 && facts.length > 0) {
      groups.set("全部", facts);
    }
    return groups;
  }, [facts, evidenceByFactId, documentId]);

  function handleReview(factId: string, action: ReviewAction) {
    reviewFact(factId, action);
  }

  function handleConfirmAll() {
    const autoFacts = facts.filter((f) => f.reviewStatus === "auto");
    for (const fact of autoFacts) {
      reviewFact(fact.id, "confirm");
    }
  }

  const autoCount = facts.filter((f) => f.reviewStatus === "auto").length;

  return (
    <div className="doc-memory-panel">
      <div className="doc-memory-header">
        <h3>文档记忆{facts.length > 0 ? ` (${facts.length} 条事实)` : ""}</h3>
        <div className="doc-memory-header-actions">
          {autoCount > 0 && (
            <button type="button" className="docs-action-button" onClick={handleConfirmAll}>
              全部确认
            </button>
          )}
          <button
            type="button"
            className="docs-action-button"
            onClick={() => setCollapsed((c) => !c)}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            {collapsed ? "展开" : "收起"}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            className="doc-memory-body"
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {isProcessing ? (
              <div className="doc-memory-extracting">
                <span>记忆提取中...</span>
                <div className="docs-progress-track">
                  <div className="docs-progress-fill is-indeterminate" />
                </div>
              </div>
            ) : status === "loading" ? (
              <div className="doc-memory-extracting">
                <div className="graph-loading-spinner" style={{ width: 16, height: 16 }} />
                <span>加载中...</span>
              </div>
            ) : facts.length === 0 ? (
              <div style={{ padding: 16 }}>
                <p className="muted">该文档暂未提取到记忆事实</p>
              </div>
            ) : (
              Array.from(chunkGroups.entries()).map(([chunkKey, chunkFacts]) => (
                <div key={chunkKey} className="doc-memory-chunk-group">
                  <div className="doc-memory-chunk-header">
                    <span>{chunkKey}</span>
                    <span>{chunkFacts.length} 条事实</span>
                  </div>
                  <div className="doc-memory-chunk-list">
                    {chunkFacts.map((fact) => (
                      <MemoryFactCard
                        key={fact.id}
                        fact={fact}
                        compact
                        onReview={handleReview}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
