import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { ReviewAction } from "@graphen/shared";
import { useMemoryStore, EMPTY_FACTS } from "../stores/useMemoryStore";
import { MemoryFactCard } from "./MemoryFactCard";
import { InlineFactForm } from "./InlineFactForm";

interface NodeMemorySectionProps {
  nodeId: string;
  nodeName: string;
}

export function NodeMemorySection({ nodeId, nodeName }: NodeMemorySectionProps) {
  const facts = useMemoryStore((s) => s.factsByNodeId[nodeId] ?? EMPTY_FACTS);
  const status = useMemoryStore((s) => s.loadingStatus[`node:${nodeId}`] ?? "idle");
  const loadFacts = useMemoryStore((s) => s.loadFactsByNodeId);
  const reviewFact = useMemoryStore((s) => s.reviewFact);
  const createFact = useMemoryStore((s) => s.createFact);

  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadFacts(nodeId);
  }, [nodeId, loadFacts]);

  function handleReview(factId: string, action: ReviewAction) {
    reviewFact(factId, action);
  }

  function handleSave(data: {
    subjectNodeId: string;
    predicate: string;
    objectText: string;
    valueType: "entity" | "text" | "number" | "date";
  }) {
    createFact(data);
    setShowForm(false);
  }

  return (
    <section>
      <h4>记忆事实{facts.length > 0 ? ` (${facts.length})` : ""}</h4>

      {status === "loading" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
          <div className="graph-loading-spinner" style={{ width: 16, height: 16 }} />
          <span className="muted" style={{ fontSize: 13 }}>加载中...</span>
        </div>
      ) : facts.length === 0 ? (
        <p className="muted">暂无记忆事实</p>
      ) : (
        <div className="stack">
          {facts.map((fact) => (
            <MemoryFactCard key={fact.id} fact={fact} onReview={handleReview} />
          ))}
        </div>
      )}

      {showForm ? (
        <div style={{ marginTop: 8 }}>
          <InlineFactForm
            subjectNodeId={nodeId}
            subjectLabel={nodeName}
            onSave={handleSave}
            onCancel={() => setShowForm(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="docs-action-button"
          style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 4 }}
          onClick={() => setShowForm(true)}
        >
          <Plus size={14} />
          手工添加事实
        </button>
      )}
    </section>
  );
}
