import type { MemoryAccessLog } from "../services/api.js";

interface AccessLogTimelineProps {
  memoryId: string;
  logs: MemoryAccessLog[];
  isLoading: boolean;
  error?: string | null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toAccessDisplay(log: MemoryAccessLog): { icon: string; label: string } {
  const accessType = log.accessType.toLowerCase();

  if (log.chatSessionId || accessType.includes("chat") || accessType.includes("conversation")) {
    const short = log.chatSessionId ? log.chatSessionId.slice(0, 6) : "";
    return { icon: "💬", label: short ? `对话#${short}` : "对话访问" };
  }

  if (accessType.includes("doc") || accessType.includes("retriev")) {
    return { icon: "📄", label: "文档检索" };
  }

  return { icon: "🧠", label: log.accessType || "记忆访问" };
}

export function AccessLogTimeline({ memoryId, logs, isLoading, error = null }: AccessLogTimelineProps) {
  if (isLoading) {
    return <p className="memory-detail-muted">加载中...</p>;
  }

  if (error) {
    return <p className="memory-detail-error">{error}</p>;
  }

  if (logs.length === 0) {
    return <p className="memory-detail-muted">暂无访问日志</p>;
  }

  return (
    <ul className="memory-access-timeline" aria-label={`记忆 ${memoryId} 的访问日志`}>
      {logs.map((log, index) => {
        const { icon, label } = toAccessDisplay(log);
        const isLast = index === logs.length - 1;

        return (
          <li key={log.id} className="memory-access-item">
            <div className="memory-access-marker" aria-hidden>
              <span className="memory-access-dot" />
              {!isLast ? <span className="memory-access-line" /> : null}
            </div>
            <div className="memory-access-body">
              <p className="memory-access-title">
                <span aria-hidden>{icon}</span>
                <span>{label}</span>
              </p>
              <p className="memory-access-time">{formatTime(log.accessedAt)}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
