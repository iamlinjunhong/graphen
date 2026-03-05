import type { MemoryEvidence } from "@graphen/shared";

const SOURCE_LABELS: Record<string, string> = {
  document: "doc",
  chat_user: "chat",
  chat_assistant: "chat",
  manual: "manual",
};

function formatRef(evidence: MemoryEvidence): string {
  if (evidence.documentId) {
    const short = evidence.documentId.slice(0, 8);
    return evidence.chunkId ? `${short} chunk#${evidence.chunkId}` : short;
  }
  if (evidence.chatSessionId) {
    const date = new Date(evidence.extractedAt);
    return `Session ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return evidence.extractedAt;
}

interface MemoryEvidenceListProps {
  evidence: MemoryEvidence[];
}

export function MemoryEvidenceList({ evidence }: MemoryEvidenceListProps) {
  if (evidence.length === 0) {
    return <p className="muted" style={{ fontSize: 12, padding: "4px 0" }}>暂无证据</p>;
  }

  return (
    <div>
      {evidence.map((ev) => (
        <div key={ev.id} className="memory-evidence-item">
          <span className={`memory-evidence-source-chip is-${ev.sourceType}`}>
            {SOURCE_LABELS[ev.sourceType] ?? ev.sourceType}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="memory-evidence-ref">{formatRef(ev)}</div>
            {ev.excerpt ? (
              <div className="memory-evidence-excerpt">"{ev.excerpt}"</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
