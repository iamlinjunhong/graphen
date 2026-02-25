import type { ChatSource } from "@graphen/shared";

interface ChatSourceCardProps {
  source: ChatSource;
  onOpenDocument: (source: ChatSource) => void;
  onOpenGraph: (source: ChatSource) => void;
}

export function ChatSourceCard({ source, onOpenDocument, onOpenGraph }: ChatSourceCardProps) {
  return (
    <article className="chat-source-card">
      <header>
        <strong>{source.documentName}</strong>
        <span>score {source.relevanceScore.toFixed(3)}</span>
      </header>
      <p>{source.snippet}</p>
      <footer>
        <button type="button" className="docs-action-button" onClick={() => onOpenDocument(source)}>
          Jump Doc
        </button>
        <button type="button" className="docs-action-button" onClick={() => onOpenGraph(source)}>
          Jump Graph
        </button>
      </footer>
    </article>
  );
}
