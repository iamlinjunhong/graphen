import { useCallback } from "react";
import MDEditor from "@uiw/react-md-editor";
import type { Document } from "@graphen/shared";
import { DocumentStatusBadge } from "./DocumentStatusBadge";
import type { EditorDraft } from "../stores/useDocumentStore";

interface DocumentEditorProps {
  document: Document | null;
  draft: EditorDraft | null;
  onContentChange: (content: string) => void;
  onDelete: (document: Document) => void;
  onReparse: (document: Document, content: string) => void;
  onDiscard: () => void;
  isDeleting: boolean;
  isReparsing: boolean;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[i]}`;
}

export function DocumentEditor({
  document,
  draft,
  onContentChange,
  onDelete,
  onReparse,
  onDiscard,
  isDeleting,
  isReparsing,
}: DocumentEditorProps) {
  const handleEditorChange = useCallback(
    (value?: string) => {
      onContentChange(value ?? "");
    },
    [onContentChange]
  );

  // Empty state: no document selected
  if (!document) {
    return (
      <section className="panel content-panel docs-editor-panel">
        <p className="muted">Select a document to view.</p>
      </section>
    );
  }

  const meta = document.metadata;
  const isDirty = draft?.isDirty ?? false;
  const isLoading = draft?.isLoadingContent ?? false;
  const truncated = draft?.truncated ?? false;
  const totalCharCount = draft?.totalCharCount ?? 0;

  const metaParts = [
    document.fileType.toUpperCase(),
    formatBytes(document.fileSize),
    meta.chunkCount != null ? `${meta.chunkCount} Chunks` : null,
    meta.entityCount != null ? `${meta.entityCount} Entities` : null,
    meta.edgeCount != null ? `${meta.edgeCount} Relations` : null,
    meta.pageCount != null ? `${meta.pageCount} Pages` : null,
  ].filter(Boolean);

  return (
    <section className="panel content-panel docs-editor-panel">
      {/* Header Bar */}
      <div className="docs-editor-header">
        <div className="docs-editor-header-top">
          <div className="docs-editor-header-title">
            <span className="docs-editor-filename">{document.filename}</span>
            <DocumentStatusBadge status={document.status} />
          </div>
        </div>
        <div className="docs-editor-meta">{metaParts.join(" · ")}</div>
      </div>

      {/* PDF info banner */}
      {document.fileType === "pdf" && (
        <div className="docs-editor-banner is-info">
          编辑的是解析文本，不是 PDF 原件。修改后 Reparse 将基于编辑文本重建图谱。
        </div>
      )}

      {/* Error banner */}
      {document.status === "error" && document.errorMessage && (
        <div className="docs-error-inline">处理失败：{document.errorMessage}</div>
      )}

      {/* Editor content area */}
      <div className="docs-editor-content">
        {isLoading ? (
          <div className="docs-editor-loading">
            <span className="spinner" />
            <span>Loading content...</span>
          </div>
        ) : (
          <MDEditor
            value={draft?.editedContent ?? ""}
            onChange={handleEditorChange}
            height="100%"
            visibleDragbar={false}
            preview="edit"
          />
        )}
      </div>

      {/* Truncation warning */}
      {truncated && (
        <div className="docs-editor-banner is-warning">
          内容已截断，仅显示前 {draft?.editedContent.length.toLocaleString()} 字符（共{" "}
          {totalCharCount.toLocaleString()} 字符）
        </div>
      )}

      {/* Action Bar */}
      <div className="docs-editor-actions">
        <div className="docs-editor-dirty-indicator">
          {isDirty ? (
            <span className="docs-editor-dirty-text">
              <span className="docs-editor-dirty-dot" />⚠ Content modified
            </span>
          ) : (
            <span className="docs-editor-clean-text">✓ No changes</span>
          )}
        </div>
        <div className="docs-editor-action-buttons">
          <button
            type="button"
            className="docs-action-button is-danger"
            disabled={isDeleting || isReparsing}
            onClick={() => onDelete(document)}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </button>
          <button
            type="button"
            className="docs-action-button"
            disabled={!isDirty || isReparsing}
            onClick={onDiscard}
          >
            Discard Changes
          </button>
          <button
            type="button"
            className="docs-action-button is-primary"
            disabled={isReparsing}
            onClick={() => onReparse(document, draft?.editedContent ?? "")}
          >
            {isReparsing ? "Reparsing..." : "Reparse"}
          </button>
        </div>
      </div>
    </section>
  );
}
