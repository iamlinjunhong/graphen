import { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import type { DocumentStatus } from "@graphen/shared";
import { DocumentStatusBadge } from "./DocumentStatusBadge";

export interface ParseLogEntry {
  id: string;
  level: "info" | "success" | "error";
  message: string;
  time: Date;
}

interface ParseConsoleProps {
  status: DocumentStatus | "pending";
  progress: number;
  isStreaming: boolean;
  logs: ParseLogEntry[];
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

export function ParseConsole({ status, progress, isStreaming, logs }: ParseConsoleProps) {
  const logBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = logBodyRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [logs]);

  return (
    <div className="parse-console-shell">
      {/* Header */}
      <div className="parse-console-header">
        <Terminal size={16} className="parse-console-header-icon" />
        Runtime Parse Console
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <small style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
            {isStreaming ? `Streaming... ${Math.round(progress)}%` : `Progress: ${Math.round(progress)}%`}
          </small>
          <DocumentStatusBadge status={status} />
        </div>
      </div>

      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 3, background: "var(--bg-secondary)" }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.max(0, Math.min(100, progress))}%`,
            background: "linear-gradient(90deg, var(--accent-primary), #e09b66)",
            transition: "width 0.3s ease"
          }}
        />
      </div>

      {/* Log body */}
      <div className="parse-console-body" ref={logBodyRef}>
        {logs.length === 0 ? (
          <p className="muted">No parse logs yet. Upload a document to begin.</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="parse-log-line">
              <span className="log-time">{formatTime(log.time)}</span>
              {" ["}
              <span className={`log-${log.level}`}>
                {log.level === "success" ? "SUCCESS" : log.level === "error" ? "ERROR" : "INFO"}
              </span>
              {"] "}
              {log.message}
            </div>
          ))
        )}
        {isStreaming && logs.length > 0 ? (
          <div className="parse-log-line">
            <span style={{ animation: "chatCursorBlink 1s steps(1,end) infinite" }}>_</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
