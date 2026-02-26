import type { Document } from "@graphen/shared";
import { DocumentStatusBadge } from "./DocumentStatusBadge";

interface DocumentPreviewProps {
  document: Document | null;
  previewText: string | null;
  onDelete: (document: Document) => void;
  onReparse: (document: Document) => void;
  isDeleting: boolean;
  isReparsing: boolean;
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

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function DocumentPreview({
  document,
  previewText,
  onDelete,
  onReparse,
  isDeleting,
  isReparsing
}: DocumentPreviewProps) {
  if (!document) {
    return (
      <section className="panel content-panel docs-preview-panel">
        <h3>Document Preview</h3>
        <p className="muted">Select a document to preview.</p>
      </section>
    );
  }

  const metadata = document.metadata;

  return (
    <section className="panel content-panel docs-preview-panel">
      <div className="docs-preview-head">
        <div>
          <h3>Document Preview</h3>
          <p className="docs-preview-filename">{document.filename}</p>
        </div>
        <DocumentStatusBadge status={document.status} />
      </div>

      <div className="docs-preview-meta">
        <div>
          <span>Type</span>
          <strong>{document.fileType.toUpperCase()}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>{formatBytes(document.fileSize)}</strong>
        </div>
        <div>
          <span>Chunks</span>
          <strong>{metadata.chunkCount ?? "-"}</strong>
        </div>
        <div>
          <span>Entities</span>
          <strong>{metadata.entityCount ?? "-"}</strong>
        </div>
        <div>
          <span>Relations</span>
          <strong>{metadata.edgeCount ?? "-"}</strong>
        </div>
        <div>
          <span>Pages</span>
          <strong>{metadata.pageCount ?? "-"}</strong>
        </div>
      </div>

      <div className="docs-preview-content" aria-label="Document preview content">
        {document.status === "error" && document.errorMessage ? (
          <div className="docs-error-inline" style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6 }}>
            处理失败：{document.errorMessage}
          </div>
        ) : null}
        {previewText && previewText.trim().length > 0 ? (
          <pre>{previewText}</pre>
        ) : (
          <p className="muted">
            Current backend does not expose full raw content preview. Uploading `.md` / `.txt` will display local snippet here.
          </p>
        )}
      </div>

      <div className="docs-preview-actions">
        <button
          type="button"
          className="docs-action-button"
          disabled={isReparsing}
          onClick={() => onReparse(document)}
        >
          {isReparsing ? "Reparsing..." : "Reparse"}
        </button>
        <button
          type="button"
          className="docs-action-button is-danger"
          disabled={isDeleting}
          onClick={() => onDelete(document)}
        >
          {isDeleting ? "Deleting..." : "Delete Document"}
        </button>
      </div>
    </section>
  );
}
