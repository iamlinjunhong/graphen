import { FileText, FileType2, File, Search, Plus } from "lucide-react";
import type { Document, DocumentStatus } from "@graphen/shared";
import { DocumentStatusBadge } from "./DocumentStatusBadge";

interface DocumentSidebarProps {
  documents: Document[];
  selectedDocumentId: string | null;
  query: string;
  status?: DocumentStatus | undefined;
  isLoading?: boolean;
  onSelect: (documentId: string) => void;
  onQueryChange: (query: string) => void;
  onStatusChange: (status?: DocumentStatus) => void;
  onUploadClick?: () => void;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return <FileType2 size={18} style={{ color: "#df6666" }} />;
  if (ext === "md") return <FileText size={18} style={{ color: "#5587a8" }} />;
  return <File size={18} style={{ color: "var(--text-muted)" }} />;
}

export function DocumentSidebar({
  documents,
  selectedDocumentId,
  query,
  status,
  isLoading,
  onSelect,
  onQueryChange,
  onStatusChange,
  onUploadClick
}: DocumentSidebarProps) {
  return (
    <aside className="side-panel docs-sidebar">

      {/* Title — standalone row */}
      <div className="side-panel-header" style={{ paddingBottom: "0.5rem" }}>
        <h2
          className="side-panel-title"
          style={{
            fontSize: "1rem",
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 600,
            color: "var(--text-primary)"
          }}
        >
          Parsed Documents
        </h2>
      </div>

      {/* Search + Upload button — same row (matches chat sidebar pattern) */}
      <div className="side-search-row" style={{ paddingTop: "0" }}>
        <div className="side-search-wrap">
          <span className="search-icon">
            <Search size={14} />
          </span>
          <input
            aria-label="Search documents"
            className="side-search-input"
            placeholder="Search files..."
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
        </div>
        {onUploadClick ? (
          <button
            type="button"
            className="icon-action-button"
            title="Upload file"
            onClick={onUploadClick}
            aria-label="Upload file"
          >
            <Plus size={16} />
          </button>
        ) : null}
      </div>

      {/* Status filter */}
      <div style={{ padding: "0 1.25rem 0.75rem 1.25rem" }}>
        <select
          aria-label="Filter document status"
          className="docs-status-select"
          value={status ?? "all"}
          onChange={(event) => {
            const nextStatus = event.currentTarget.value;
            onStatusChange(nextStatus === "all" ? undefined : (nextStatus as DocumentStatus));
          }}
        >
          <option value="all">All Status</option>
          <option value="uploading">Uploading</option>
          <option value="parsing">Parsing</option>
          <option value="extracting">Extracting</option>
          <option value="embedding">Embedding</option>
          <option value="completed">Completed</option>
          <option value="error">Error</option>
        </select>
      </div>

      {/* Document list */}
      <div className="docs-list" role="list" aria-label="Documents">
        {documents.map((document) => (
          <button
            key={document.id}
            type="button"
            className={`doc-list-item${document.id === selectedDocumentId ? " is-selected" : ""}`}
            onClick={() => onSelect(document.id)}
          >
            <div className="doc-list-icon">
              {getFileIcon(document.filename)}
            </div>
            <div className="doc-list-info">
              <span className="doc-list-name">{document.filename}</span>
              <div className="doc-list-meta">
                <span>{formatBytes(document.fileSize)}</span>
                <DocumentStatusBadge status={document.status} />
              </div>
            </div>
          </button>
        ))}

        {documents.length === 0 ? (
          <p className="muted docs-empty">
            {isLoading ? "Loading documents..." : "No documents"}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
