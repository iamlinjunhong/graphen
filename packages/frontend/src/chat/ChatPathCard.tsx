import { GitBranch } from "lucide-react";
import type { SourcePath } from "@graphen/shared";

interface ChatPathCardProps {
  path: SourcePath;
  onNodeClick: (nodeName: string) => void;
}

export function ChatPathCard({ path, onNodeClick }: ChatPathCardProps) {
  return (
    <article className="chat-path-card">
      <span className="chat-path-icon">
        <GitBranch size={12} strokeWidth={2} />
      </span>
      <div className="chat-path-steps">
        {path.nodes.map((node, i) => (
          <span key={`${node}-${i}`} className="chat-path-step">
            <button
              type="button"
              className="chat-path-node"
              onClick={() => onNodeClick(node)}
              title={`跳转到图谱节点: ${node}`}
            >
              {node}
            </button>
            {i < path.relations.length ? (
              <span className="chat-path-relation">
                {path.relations[i]}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </article>
  );
}
